import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadAcmosConfig } from '../../src/config/load.ts';

let home: string;
const savedEnv = { ...process.env };

function write(name: string, content: string): void {
  writeFileSync(join(home, name), content, 'utf8');
}

const MINIMAL = `
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    apiKey: sk-test
combo:
  fast:
    members:
      - { provider: deepseek, model: deepseek-chat }
`;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'acmos-cfg-'));
  process.env.ACMOS_HOME = home;
  process.env.ACMOS_CONFIG = undefined;
  delete process.env.ACMOS_CONFIG;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe('loadAcmosConfig', () => {
  test('套用 schema 默认值', async () => {
    write('config.yml', MINIMAL);
    const { config, sourcePath } = await loadAcmosConfig();

    expect(sourcePath).toContain('config.yml');
    expect(config.port).toBe(20129);
    expect(config.host).toBe('127.0.0.1');
    expect(config.log.captureBody).toBe(false);
    expect(config.catalog.url).toBe('https://models.dev/api.json');
    expect(config.combo.fast?.sticky).toBe(true);
  });

  test('apiKey 简写归一成 bearer auth', async () => {
    write('config.yml', MINIMAL);
    const { auth } = await loadAcmosConfig();
    expect(auth.deepseek).toEqual({
      type: 'bearer',
      keys: ['sk-test'],
      keyStrategy: 'round-robin',
    });
  });

  test('从 .env 取 ${env:X}', async () => {
    write('.env', 'DS_KEY=sk-from-dotenv\n');
    write(
      'config.yml',
      `
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    apiKey: \${env:DS_KEY}
`,
    );
    const { auth } = await loadAcmosConfig();
    expect(auth.deepseek?.keys).toEqual(['sk-from-dotenv']);
  });

  test('${env:X:-fallback} 在变量缺失时生效', async () => {
    write(
      'config.yml',
      `
proxy: \${env:ACMOS_TEST_PROXY:-http://127.0.0.1:7890}
providers: {}
`,
    );
    const { config } = await loadAcmosConfig();
    expect(config.proxy).toBe('http://127.0.0.1:7890');
  });

  test('环境变量缺失且无默认值时报错，而不是静默变空串', async () => {
    write(
      'config.yml',
      `
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    apiKey: \${env:ACMOS_DEFINITELY_MISSING}
`,
    );
    expect(loadAcmosConfig()).rejects.toThrow(/ACMOS_DEFINITELY_MISSING/);
  });

  test('extends 分层深合并', async () => {
    write(
      'base.yml',
      `
port: 30000
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    apiKey: sk-base
`,
    );
    write(
      'config.yml',
      `
extends: ./base.yml
providers:
  opencode:
    wire: cc
    baseUrl: https://opencode.ai/zen/v1
    apiKey: sk-zen
`,
    );
    const { config, layers } = await loadAcmosConfig();
    expect(config.port).toBe(30000);
    expect(Object.keys(config.providers).sort()).toEqual(['deepseek', 'opencode']);
    expect(layers.length).toBe(2);
  });

  test('combo 引用不存在的 provider 时报错', async () => {
    write(
      'config.yml',
      `
providers: {}
combo:
  fast:
    members:
      - { provider: ghost, model: whatever }
`,
    );
    expect(loadAcmosConfig()).rejects.toThrow(/不存在的 provider "ghost"/);
  });

  test('provider 与 combo 同名时报错，避免路由歧义', async () => {
    write(
      'config.yml',
      `
providers:
  fast:
    wire: cc
    baseUrl: https://api.deepseek.com
combo:
  fast:
    members:
      - { provider: fast, model: x }
`,
    );
    expect(loadAcmosConfig()).rejects.toThrow(/同时是 provider 和 combo/);
  });

  test('apiKey 与 auth 同时配置时报错', async () => {
    write(
      'config.yml',
      `
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    apiKey: sk-a
    auth:
      type: bearer
      keys: [sk-b]
`,
    );
    expect(loadAcmosConfig()).rejects.toThrow(/二选一/);
  });

  test('proxy: true 但顶层未配置 proxy 时报错', async () => {
    write(
      'config.yml',
      `
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    proxy: true
`,
    );
    expect(loadAcmosConfig()).rejects.toThrow(/未配置 proxy/);
  });

  test('模型标识重复时报错', async () => {
    write(
      'config.yml',
      `
providers:
  deepseek:
    wire: cc
    baseUrl: https://api.deepseek.com
    models:
      - id: a
      - id: a
`,
    );
    expect(loadAcmosConfig()).rejects.toThrow(/重复的模型标识 "a"/);
  });

  test('未知字段被 strict schema 拦下', async () => {
    write('config.yml', 'porrt: 1\nproviders: {}\n');
    expect(loadAcmosConfig()).rejects.toThrow(/配置不合法/);
  });

  test('配置文件缺失时给出明确指引', async () => {
    expect(loadAcmosConfig()).rejects.toThrow(ConfigError);
    expect(loadAcmosConfig()).rejects.toThrow(/找不到配置文件/);
  });

  // 示例配置最容易随 schema 漂移而失效，用测试钉住。
  test('仓库里的 config.example.yml 可以直接加载', async () => {
    write('.env', 'OPENCODE_KEY_1=sk-a\nDEEPSEEK_API_KEY=sk-b\nARK_API_KEY=sk-c\n');
    copyFileSync(join(import.meta.dir, '../../config.example.yml'), join(home, 'config.yml'));

    const { config, auth } = await loadAcmosConfig();
    expect(config.port).toBe(20129);
    expect(Object.keys(config.providers)).toContain('codex');
    expect(config.providers.codex?.wire).toBe('resp');
    expect(auth.codex?.type).toBe('chatgpt-oauth');
    expect(auth['ark-am']?.header).toBe('x-api-key');
    expect(Object.keys(config.combo).sort()).toEqual(['coder', 'fast', 'max']);
  });
});

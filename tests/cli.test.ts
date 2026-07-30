import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'acmos-cli-'));
  dirs.push(home);
  writeFileSync(
    join(home, 'config.yml'),
    [
      'host: 127.0.0.9',
      'port: 23456',
      'catalog: { enabled: false }',
      'providers: {}',
      'combo: {}',
    ].join('\n'),
  );
  const env: Record<string, string | undefined> = { ...process.env, ACMOS_HOME: home };
  delete env.ACMOS_CONFIG;
  const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('CLI documentation', () => {
  test('--help prints configured connection details and complete URLs', async () => {
    const result = await runCli('--help');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Host/IP             127.0.0.9');
    expect(result.stdout).toContain('Port                23456');
    expect(result.stdout).toContain('OpenAI Base URL     http://127.0.0.9:23456/v1');
    expect(result.stdout).toContain('POST http://127.0.0.9:23456/v1/messages');
    expect(result.stdout).toContain('Agent 文档: acmos --llm');
  });

  test('--llm prints an agent-readable configuration and diagnostic guide', async () => {
    const result = await runCli('--llm');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('# acmos Agent Guide');
    expect(result.stdout).toContain('- Status: not-running');
    expect(result.stdout).toContain('- Host/IP: 127.0.0.9');
    expect(result.stdout).toContain('- Port: 23456');
    expect(result.stdout).toContain('## Client configuration');
    expect(result.stdout).toContain('model: <choose an ID from GET /v1/models>');
    expect(result.stdout).toContain('proxy: true');
    expect(result.stdout).toContain('## Diagnostic procedure');
    expect(result.stdout).toContain('## Safety');
  });
});

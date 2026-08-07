# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.13] - 2026-08-07

### Fixed

- Vision sidecar no longer forwards images to text-only models when every
  vision model is unavailable. Previously, when all configured vision sidecar
  models failed (e.g. quota exhausted / insufficient balance), the original
  images were kept and sent to the text-only fallback member, producing a
  confusing upstream `400 Model only support text input`. The target now raises
  `UpstreamCompatibilityError`, so a combo skips that member and tries the next
  one; a direct text-only target surfaces a clear error instead of the upstream
  400.

## [0.1.12] - 2026-08-05

### Added

- Vision sidecar failover: when a combo member cannot handle images, configured
  vision models describe the images to text in order, with retryable failover.

## [0.1.11] - 2026-08-05

### Added

- Default failover and rayinai-codex fallback.

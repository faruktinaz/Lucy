# Changelog

All notable changes to Orbit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Command palette in the web client, opened with `ctrl+k`.

## [0.3.0] - 2026-03-18

### Added

- Rate limiting for write endpoints, configured in `config/limits.toml`.
- Architecture, API and setup documentation.

### Changed

- `orbitctl` reads the server address from `ORBIT_URL`.

## [0.2.0] - 2026-03-09

### Added

- `orbitctl`, a command-line client written in Go.
- Weekly throughput report in `analysis/task_throughput.py`.

## [0.1.0] - 2026-03-05

### Added

- Task and note API with in-memory stores.
- Web client with a task list and a note editor.

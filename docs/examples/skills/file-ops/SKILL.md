---
name: file-ops
description: File listing and reading utility — list directory contents or read a file.
---

# File Operations Skill

Provides basic file system operations for the workspace.

## Available Actions

### List Directory
Given a directory path, list its contents (files and subdirectories).

### Read File
Given a file path, read and return its contents.

## Safety
- Only access files within the configured workspace directory.
- Do not follow symlinks outside the workspace.
- Refuse requests for sensitive paths (e.g., `/etc/passwd`, `~/.ssh/`).

---
name: workspace-analyst
description: Analyzes workspace structure, reads key files, and produces a structured project report. Exercises multi-step tool use (list dirs, read files, run shell commands).
---

# Workspace Analyst Skill

When invoked, perform a structured analysis of the current workspace.

## Procedure

1. **List the project root** — Use your directory listing tool to enumerate top-level files and directories.
2. **Read package.json** — Extract the project name, version, dependencies, and scripts.
3. **Check git status** — Run `git log --oneline -5` to show recent commits.
4. **Read README.md** — Extract the first 20 lines to summarize the project purpose.
5. **Produce a report** — Combine your findings into a structured summary with sections:
   - Project Name & Version
   - Recent Git Activity (last 5 commits)
   - Key Dependencies
   - Available Scripts
   - Project Summary (from README)

## Output Format

Return a well-formatted markdown report. Include all sections even if a step produced no data (note "not available").

# CodexProV4 workspace rules

- Goal: maintain CodexProV4 as an isolated CodexProV3-derived MCP server with safe document reading and bounded media transfer.
- Keep `D:\work\codexprov3` and the `D:\work` root package files unchanged unless the user explicitly expands scope.
- Preserve workspace confinement, blocked-path checks, secret redaction for text, and read-only annotations for transfer tools.
- Match validation effort to risk: run focused checks while developing, then one complete build/smoke pass at the final milestone.
- Maintain `PROJECTS.md` continuously. After every completed work batch, update what was done, what is next, what remains, the goal, and possible follow-on work.

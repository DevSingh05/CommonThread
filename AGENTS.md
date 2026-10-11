# CommonThread contributor instructions

Read `notes.md` and your branch's file in `docs/handoffs/` before changing code.

- Four human teammates own four feature branches. Implement only your assigned branch. Do not launch agents to implement the other teammates' work.
- Keep the shared conversation central; never parse agent prose to authorize actions.
- TypeScript is strict. Validate untrusted input at boundaries. SQLite is the source of truth; a transcript is not an execution protocol.
- Use the existing human Git identity. Never add an AI author, co-author, signed-off-by, or generated-by attribution to commits. Commit coherent, tested milestones, not every file or an entire day's work.
- Preserve unrelated and uncommitted work. No force pushes, destructive resets, global Git config changes, or automatic repository commits/pushes by the application.
- This is a local application, not a hosted website. Execution requires a persistent Node process. Bind localhost and protect local mutation requests.
- Mock output must say simulated; fixture evidence must never say a test actually ran.
- Real provider SDK integration belongs to the provider teammate. Verify installed types and official docs before implementing. No invented methods, scraped credentials, permissive default execution, or claims of verified live behavior without a successful live check.
- Run typecheck, lint, tests, build, and the branch-specific acceptance checks. Record actual outcomes and limitations.
- Keep changes within the ownership table in `notes.md`. Coordinate contract changes there; add new branch-specific modules rather than editing another teammate's files.


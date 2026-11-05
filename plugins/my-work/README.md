# My work

Your Jira issues, Bitbucket pull requests and GitHub issues and pull requests on one page, ported from dsh-work-items.

- **Jira and Bitbucket** go through the Atlassian server in Settings → MCP servers, so they use the sign-in saved there. The default server name is `atlassian`.
- **GitHub** runs the `gh` CLI on the server machine. It is off until you turn it on.
- **Start work** opens a new thread with the task in the message box. It can also ask the agent to create a `feature/KEY-slug` branch and move the issue to In Progress. The plugin never runs git itself.
- **Review in a thread** opens a new thread with the pull request, its comments and its diff.

Turn it on and configure it in Settings → Plugins → My work. **Diagnose** on the page checks the Atlassian connection one step at a time.

A Jira issue names no repository, so its thread starts without a project. GitHub items open in the matching project when one exists.

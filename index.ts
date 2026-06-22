/**
 * rlm-pi — Pi SDK agent harness (bun.js runtime)
 *
 * Uses DefaultResourceLoader to discover extensions, skills,
 * prompts, and context files from cwd and ~/.pi/agent.
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt(process.argv[2] ?? "What files are in the current directory?");

console.log();

session.dispose();

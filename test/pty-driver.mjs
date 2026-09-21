import { spawn } from "@homebridge/node-pty-prebuilt-multiarch";
import { stripVTControlCharacters } from "node:util";

const request = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
let output = "";
let interactionIndex = 0;
let matchOffset = 0;
let settled = false;
const normalize = (value) => value.replaceAll("\r\n", "\n").replaceAll("\r", "");
const visible = () => stripVTControlCharacters(normalize(output));
const finish = (response) => {
  if (settled) return;
  settled = true;
  process.stdout.write(JSON.stringify(response), () => process.exit(0));
};
let child;
try {
  child = spawn(process.execPath, [request.cliPath, ...request.args], {
    cwd: request.cwd,
    env: request.env,
    name: "xterm-color",
    cols: 120,
    rows: 30
  });
} catch (error) {
  finish({ error: error instanceof Error ? error.message : String(error) });
}
if (child) {
  const timer = setTimeout(() => {
    child.kill();
    finish({ error: `Interactive CLI timed out before interaction ${interactionIndex + 1}. stdout: ${normalize(output)}` });
  }, request.timeoutMs);
  const advance = () => {
    let interaction = request.interactions[interactionIndex];
    let terminal = visible();
    while (interaction) {
      const match = terminal.indexOf(interaction.waitFor, matchOffset);
      if (match < 0) return;
      matchOffset = match + interaction.waitFor.length;
      interactionIndex += 1;
      child.write(interaction.input);
      interaction = request.interactions[interactionIndex];
      terminal = visible();
    }
  };
  const dataSubscription = child.onData((chunk) => { output += chunk; advance(); });
  const exitSubscription = child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    setTimeout(() => {
      advance();
      dataSubscription.dispose();
      exitSubscription.dispose();
      const stdout = normalize(output);
      const response = interactionIndex !== request.interactions.length
        ? { error: `Interactive CLI exited before interaction ${interactionIndex + 1}. stdout: ${stdout}` }
        : { result: { status: exitCode, stdout, stderr: "" } };
      finish(response);
    }, process.platform === "win32" ? 250 : 0);
  });
}

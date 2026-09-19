import { spawn } from "@homebridge/node-pty-prebuilt-multiarch";

const request = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
let output = "";
let interactionIndex = 0;
let settled = false;
const normalize = (value) => value.replaceAll("\r\n", "\n").replaceAll("\r", "");
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
    const interaction = request.interactions[interactionIndex];
    if (interaction && normalize(output).includes(interaction.waitFor)) {
      interactionIndex += 1;
      child.write(interaction.input);
    }
  };
  child.onData((chunk) => { output += chunk; advance(); });
  child.onExit(({ exitCode }) => {
    clearTimeout(timer);
    const stdout = normalize(output);
    if (interactionIndex !== request.interactions.length) {
      finish({ error: `Interactive CLI exited before interaction ${interactionIndex + 1}. stdout: ${stdout}` });
      return;
    }
    finish({ result: { status: exitCode, stdout, stderr: "" } });
  });
}

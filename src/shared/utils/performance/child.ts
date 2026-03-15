import { Message, start } from "./types.js";
import lighthouse from "lighthouse";

console.error(JSON.stringify({ message: "Child init", level: "info" }));

const send = (msg: Message) => process.send && process.send(msg);

const start = async ({ url, config, options }: start) => {
  try {
    console.error(
      JSON.stringify({ message: "Child got payload, starting lighthouse", level: "info" }),
    );
    const results = await lighthouse(url, options, config);

    send({
      data: results?.lhr,
      event: "complete",
    });
  } catch (error: unknown) {
    send({
      error,
      event: "error",
    });
  }
};

process.on("message", (payload) => {
  const { event } = payload as { event: string };

  if (event === "start") {
    return start(payload as start);
  }

  return;
});

send({ event: "created" });

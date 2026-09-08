import net from "node:net";

/**
 * A throwaway SMTP server, just complete enough for a real client to hand it a
 * message.
 *
 * Testing the mail adapter against a mock of nodemailer would only prove the
 * mock was called. This speaks the actual protocol, so a broken envelope, a
 * missing header or a mangled body shows up as a failing test.
 *
 * Plain SMTP on loopback with AUTH PLAIN and AUTH LOGIN — no TLS, because
 * there is no secret here worth protecting and a self-signed certificate would
 * add a second moving part to every test.
 */

export type CapturedMessage = {
  from: string;
  to: string[];
  data: string;
  username?: string;
  password?: string;
};

export type FakeSmtpServer = {
  port: number;
  messages: CapturedMessage[];
  /** How many times a client opened a connection — a retry shows up here. */
  connections: () => number;
  close: () => Promise<void>;
};

export async function startFakeSmtp(
  options: { rejectAuth?: boolean } = {},
): Promise<FakeSmtpServer> {
  const messages: CapturedMessage[] = [];
  let connections = 0;

  const server = net.createServer((socket) => {
    connections += 1;
    let buffer = "";
    let inData = false;
    let awaiting: "plain" | "username" | "password" | null = null;

    const current: CapturedMessage = { from: "", to: [], data: "" };

    const say = (line: string) => socket.write(line + "\r\n");

    const authReply = () =>
      options.rejectAuth
        ? "535 5.7.8 Authentication credentials invalid"
        : "235 2.7.0 Authentication successful";

    /** AUTH PLAIN carries "authzid\0username\0password" in one base64 blob. */
    const acceptPlain = (decoded: string) => {
      const NUL = String.fromCharCode(0);
      const [, username = "", password = ""] = decoded.split(NUL);
      current.username = username;
      current.password = password;
    };

    say("220 fieldbase.test ESMTP");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      let index: number;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          // A lone dot ends the body; anything else is content.
          if (line === ".") {
            inData = false;
            messages.push({ ...current, to: [...current.to] });
            current.data = "";
            current.to = [];
            say("250 2.0.0 Ok: queued");
          } else {
            // Dot-stuffing: a body line starting with . is sent as ..
            current.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          }
          continue;
        }

        if (awaiting) {
          const decoded = Buffer.from(line, "base64").toString("utf8");

          if (awaiting === "plain") {
            acceptPlain(decoded);
            awaiting = null;
            say(authReply());
          } else if (awaiting === "username") {
            current.username = decoded;
            awaiting = "password";
            say("334 " + Buffer.from("Password:").toString("base64"));
          } else {
            current.password = decoded;
            awaiting = null;
            say(authReply());
          }
          continue;
        }

        const [verb, ...rest] = line.split(" ");
        const command = verb.toUpperCase();
        const argument = rest.join(" ");

        switch (command) {
          case "EHLO":
            // Advertised one per line, the last without the continuation dash.
            say("250-fieldbase.test");
            say("250-AUTH PLAIN LOGIN");
            say("250 8BITMIME");
            break;

          case "HELO":
            say("250 fieldbase.test");
            break;

          case "AUTH": {
            // nodemailer picks PLAIN when the server advertises it and sends
            // the credentials on the AUTH line itself. LOGIN is the two-step
            // challenge some older servers still require, so both are handled.
            const [mechanism, inline] = argument.split(" ");

            if (mechanism.toUpperCase() === "PLAIN") {
              if (inline) {
                acceptPlain(Buffer.from(inline, "base64").toString("utf8"));
                say(authReply());
              } else {
                awaiting = "plain";
                say("334 ");
              }
            } else {
              awaiting = "username";
              say("334 " + Buffer.from("Username:").toString("base64"));
            }
            break;
          }

          case "MAIL":
            current.from = extractAddress(argument);
            say("250 2.1.0 Ok");
            break;

          case "RCPT":
            current.to.push(extractAddress(argument));
            say("250 2.1.5 Ok");
            break;

          case "DATA":
            inData = true;
            say("354 End data with <CR><LF>.<CR><LF>");
            break;

          case "QUIT":
            say("221 2.0.0 Bye");
            socket.end();
            break;

          default:
            say("250 2.0.0 Ok");
        }
      }
    });

    socket.on("error", () => {
      // A client hanging up mid-conversation is normal here.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Fake SMTP server did not bind to a port.");
  }

  return {
    port: address.port,
    messages,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A local port that is verified to refuse connections right now.
 *
 * The obvious way to get one — bind a server, note the port, close it — is a
 * race, and a nasty one. `listen(0)` allocates from the ephemeral range, which
 * is precisely the range the OS hands to the *next* caller of `listen(0)`. So
 * the port a test just released is one of the likeliest to be taken again, and
 * when the taker is another fake SMTP server in the same file, a test asserting
 * "nothing is listening here" gets a real SMTP conversation instead. That
 * failed roughly one run in three, always with a different error than the one
 * under test, which is the worst kind of flake: it looks like a product bug.
 *
 * So the port is checked before it is handed out, and rechecked if something
 * grabbed it. The caller still gets a closed port or a clear failure, never a
 * coin flip.
 */
export async function closedPort(attempts = 10): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = await freePort();
    if (await refusesConnection(candidate)) return candidate;
  }

  throw new Error(
    `Could not find a closed local port after ${attempts} attempts.`,
  );
}

/** Asks the OS for a port, then gives it straight back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("No port was assigned.")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** True when connecting is actively refused, rather than accepted or hung. */
function refusesConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });

    const done = (refused: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(refused);
    };

    // A connection that neither opens nor refuses is not proof of anything.
    socket.setTimeout(1000, () => done(false));
    socket.on("connect", () => done(false));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED"),
    );
  });
}

/** Pulls the address out of `FROM:<someone@example.com>`. */
function extractAddress(argument: string) {
  return argument.replace(/^.*?:/, "").replace(/[<>]/g, "").trim();
}

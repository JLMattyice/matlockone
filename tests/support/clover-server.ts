import http from "node:http";

/**
 * A stand-in for Clover's Ecommerce Hosted Checkout endpoint.
 *
 * Shaped from their documented request and response, so the adapter is
 * exercised over real HTTP: the merchant header, the Bearer key, the
 * shoppingCart shape, and the status codes — including 406, Clover's own
 * symptom for a token created under the wrong integration type.
 *
 * It is not Clover. Only a sandbox merchant proves their API matches this.
 */

export type FakeCloverOptions = {
  privateKey?: string;
  merchantId?: string;
  /** Force a failure instead of the happy path. */
  failWith?: { status: number; body?: unknown };
  /** Answer 200 but without the href, as a changed response would. */
  withoutHref?: boolean;
};

export type FakeClover = {
  baseUrl: string;
  requests: {
    method: string;
    path: string;
    auth: string | undefined;
    merchantId: string | undefined;
    body: Record<string, unknown>;
  }[];
  close: () => Promise<void>;
};

function send(response: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export async function startFakeClover(
  options: FakeCloverOptions = {},
): Promise<FakeClover> {
  const privateKey = options.privateKey ?? "clover-private-key";
  const merchantId = options.merchantId ?? "MERCH123";
  const requests: FakeClover["requests"] = [];

  let counter = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return send(response, 400, { message: "Body was not JSON" });
      }

      requests.push({
        method: request.method ?? "GET",
        path: request.url ?? "",
        auth: request.headers.authorization,
        merchantId: request.headers["x-clover-merchant-id"] as string | undefined,
        body,
      });

      if (request.headers.authorization !== `Bearer ${privateKey}`) {
        return send(response, 401, { message: "401 Unauthorized" });
      }

      if (request.headers["x-clover-merchant-id"] !== merchantId) {
        return send(response, 404, { message: "Merchant not found" });
      }

      if (options.failWith) {
        return send(
          response,
          options.failWith.status,
          options.failWith.body ?? { message: "Something went wrong" },
        );
      }

      if (!(request.url ?? "").startsWith("/invoicingcheckoutservice/v1/checkouts")) {
        return send(response, 404, { message: "Unknown path" });
      }

      const id = `sess_${++counter}`;
      const createdTime = Date.now();

      return send(response, 200, {
        ...(options.withoutHref ? {} : { href: `https://checkout.clover.test/${id}` }),
        checkoutSessionId: id,
        createdTime,
        // Fifteen minutes, which is the whole reason this provider works the
        // way it does.
        expirationTime: createdTime + 15 * 60 * 1000,
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

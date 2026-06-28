/**
 * In-process port allocator with reservation tracking.
 *
 * `findFreePort` (bind to :0, read the assigned port, close) has a TOCTOU race
 * under parallelism: the moment it closes its probe socket the port is free
 * again, and the real consumer — an Appium driver's `systemPort` /
 * `wdaLocalPort` / `mjpegServerPort` — does not bind it until seconds later
 * during session creation. Two concurrent allocations can therefore pick the
 * SAME port inside that window and then collide when both sessions start.
 *
 * We close the window by reserving every allocated port in a shared Set and
 * skipping any candidate already reserved. A reservation is released once
 * session creation finishes: on success the port is by then bound by Appium
 * (the OS itself prevents reuse), and on failure the port is genuinely free
 * again — either way the reservation has served its only purpose, guarding the
 * creation window.
 *
 * Scope: this guards races WITHIN one process — the runner's control plane that
 * creates N sessions concurrently. Cross-process / remote allocation must
 * happen node-side (see the appium-mcp node-side port-allocation change).
 */

import * as net from 'net';

/** Ports handed out by `allocatePort` and not yet released. */
const reserved = new Set<number>();

/** Ask the OS for a free ephemeral port (bind :0, read it, release the probe). */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

/**
 * Allocate a free port that is not already reserved in this process, and
 * reserve it. The check-and-reserve is synchronous (no `await` between probing
 * and reserving), so two concurrent callers can never reserve the same port.
 * Release with {@link releasePort} once the consumer has bound it.
 */
export async function allocatePort(maxAttempts = 100): Promise<number> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = await findFreePort();
    // Synchronous from here — atomic w.r.t. other allocatePort() callers.
    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error(
    `Could not allocate a free port after ${maxAttempts} attempts ` +
      `(${reserved.size} currently reserved).`
  );
}

/** Allocate `count` distinct reserved ports. */
export async function allocatePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) ports.push(await allocatePort());
  return ports;
}

/** Release a single reservation. */
export function releasePort(port: number): void {
  reserved.delete(port);
}

/** Release several reservations (after session creation settles). */
export function releasePorts(ports: Iterable<number>): void {
  for (const p of ports) reserved.delete(p);
}

/** Snapshot of currently-reserved ports (diagnostics / tests). */
export function reservedPorts(): number[] {
  return [...reserved];
}

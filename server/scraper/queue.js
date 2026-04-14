import PQueue from "p-queue";

const queue = new PQueue({ concurrency: 2, interval: 500, intervalCap: 2 });

export function enqueue(fn) {
  return queue.add(fn);
}

export function queueSize() {
  return queue.size + queue.pending;
}

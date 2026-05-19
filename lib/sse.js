export function openStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Initial padding so proxies/buffers flush right away.
  res.write(':\n\n');
  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`event: ${event}\n`);
    res.write(`data: ${payload.replace(/\n/g, '\ndata: ')}\n\n`);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try { res.end(); } catch {}
  };
  res.on('close', () => { closed = true; });
  return { send, close, isClosed: () => closed };
}

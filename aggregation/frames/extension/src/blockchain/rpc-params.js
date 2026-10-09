// Send explicit positional parameters for compatibility with strict RPC gateways.
export function withPositionalRpcParams(_request, init) {
  const payload = JSON.parse(init.body);
  if (Array.isArray(payload) || payload.params !== undefined) return init;
  return {...init, body: JSON.stringify({...payload, params: []})};
}

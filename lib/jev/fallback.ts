/** Conservative local signals while semantic evaluation is pending. */
export function unquotedMessage(text: string) {
  return text
    .split(
      /\n\s*(?:On .{1,200}wrote:|From:|[-_]{3,}\s*(?:Original|Forwarded)|Quoted (?:old|previous) (?:email|message):)/i,
    )[0]
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .slice(0, 8000);
}
export function explicitReplyRequested(text: string) {
  const body = unquotedMessage(text);
  if (
    /\b(no (?:reply|response|action) (?:is )?(?:needed|required)|nothing (?:you need|else) to do|all (?:done|set)|cancel (?:that|the) request)\b/i.test(
      body,
    )
  )
    return false;
  if (
    /\b(unsubscribe|tickets? (?:on sale|available)|donate|reply (?:yes|sale)|limited.time offer)\b/i.test(
      body,
    )
  )
    return false;
  return (
    /\b(?:please|can you|could you|would you|will you)\b.{0,120}\b(?:reply|respond|confirm|approve|let me know|send me|tell me)\b/i.test(
      body,
    ) ||
    /\b(?:what|which|when|where|how|are you|is .{1,30} (?:okay|ok)|does .{1,30} work)\b[^\n?]{0,180}\?/i.test(
      body,
    )
  );
}

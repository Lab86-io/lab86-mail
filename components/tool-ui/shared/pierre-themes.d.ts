// Type shims for the vendored Pierre highlighter themes (plain JS payloads
// shipped by the tool-ui registry alongside code-block/code-diff).
declare module '*/pierre-dark-theme.js' {
  const theme: Record<string, unknown>;
  export default theme;
}
declare module '*/pierre-light-theme.js' {
  const theme: Record<string, unknown>;
  export default theme;
}

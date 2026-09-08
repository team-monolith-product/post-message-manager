{
  const hash = new URLSearchParams(location.search).get("bundleSha256");
  if (hash !== null && !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid bundle SHA-256.");
  const integrity = hash
    ? ' integrity="sha256-' +
      btoa(
        String.fromCharCode(
          ...hash.match(/../g).map((hex) => parseInt(hex, 16)),
        ),
      ) +
      '"'
    : "";
  document.write(
    '<script src="/dist/post-message-manager.js"' +
      integrity +
      ' onload="window.__bundleLoaded = true" onerror="window.__bundleLoaded = false"><\/script>',
  );
  window.__bundleSha256 = hash;
}

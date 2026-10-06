// Preserve the historical printed path, but retire its mail-only form and private
// snapshots. The current QR application resolves live inventory on the server.
(() => {
  try {
    const destination=new URL(window.TANMAR_CONFIG?.serviceRequestUrl||"http://localhost:5174/");
    if(!["http:","https:"].includes(destination.protocol)||destination.username||destination.password)throw new Error();
    if(destination.origin===location.origin&&destination.pathname===location.pathname)throw new Error();
    const params=new URLSearchParams(location.search);
    const key=params.has("id")?"id":"a";
    const value=params.get(key)||"";
    const pattern=key==="id"?/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/:/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,127}$/;
    if(!pattern.test(value))throw new Error();
    destination.search="";destination.hash="";
    destination.searchParams.set(key,value);
    // Replace this history entry. Already printed URLs/history/server logs cannot
    // be erased by this redirect; never forward their private query fields.
    location.replace(destination.href);
  } catch {
    document.getElementById("redirectMessage").textContent="This label cannot open the service form. Contact TanMar for help.";
  }
})();

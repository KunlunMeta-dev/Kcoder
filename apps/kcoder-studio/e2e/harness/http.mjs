export async function login(baseUrl, token) {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    body: new URLSearchParams({ token }),
  });
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  if (response.status !== 303 || !cookie.startsWith("kcoder_studio_session=")) {
    throw new Error(`login failed with HTTP ${response.status}`);
  }
  return cookie;
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
}


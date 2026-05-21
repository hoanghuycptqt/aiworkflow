"""Parse the cookie string format used by VCW's Credential.metadata.sessionCookies."""


def parse_cookie_string(cookie_string: str) -> list[dict]:
    """Convert 'name=val; name=val' into Playwright add_cookies() input.

    Each cookie is duplicated across .google.com and .labs.google because the DB
    string does not carry domain info — mirror the Chrome connector behavior
    (server/src/connectors/google-flow/connector.js setCookie loop).
    """
    if not cookie_string:
        return []
    out: list[dict] = []
    for part in cookie_string.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        value = value.strip()
        if not name:
            continue
        for domain in (".google.com", ".labs.google"):
            out.append({
                "name": name,
                "value": value,
                "domain": domain,
                "path": "/",
                "secure": True,
                "httpOnly": False,
            })
    return out


def stringify_cookies(cookies: list[dict]) -> str:
    """Convert Playwright cookies list back to 'name=val; name=val' format for DB storage.

    Deduplicates by name (cookies often appear with multiple domains).
    """
    seen: dict[str, str] = {}
    for c in cookies:
        name = c.get("name")
        value = c.get("value")
        if not name:
            continue
        if name not in seen:
            seen[name] = value
    return "; ".join(f"{n}={v}" for n, v in seen.items())

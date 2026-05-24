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

    Deduplicates by name. When the same name appears under multiple domains
    (because parse_cookie_string seeds every cookie to both .google.com AND
    .labs.google), prefer the .labs.google entry: NextAuth's session-token
    rotation writes a fresh Set-Cookie scoped to labs.google, leaving the
    .google.com shadow with the stale pre-rotation value. Picking the wrong
    one feeds the server an already-rotated JWT and freezes `expires` in the
    past (root cause of the 2026-05-24 02:00Z 10s-loop incident).
    """
    by_name: dict[str, dict] = {}  # name → cookie dict
    for c in cookies:
        name = c.get("name")
        if not name:
            continue
        prev = by_name.get(name)
        if prev is None:
            by_name[name] = c
            continue
        # Prefer entry whose domain ends with "labs.google" over a .google.com shadow.
        prev_domain = (prev.get("domain") or "").lower()
        curr_domain = (c.get("domain") or "").lower()
        prev_is_labs = prev_domain.endswith("labs.google")
        curr_is_labs = curr_domain.endswith("labs.google")
        if curr_is_labs and not prev_is_labs:
            by_name[name] = c
    return "; ".join(f"{n}={c.get('value', '')}" for n, c in by_name.items())

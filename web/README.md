# web — the straight-faced product page

Hugo (extended), custom theme `refusal`, one page. It is a port of the original
single-file `index.html`, which is still sitting in this directory as the
reference — the rendered page's visible copy is byte-identical to it. Delete
`index.html` whenever you're satisfied the port is faithful.

## Running it

```bash
hugo server          # :1313, environment=development
hugo --gc --minify   # build to public/
```

The demo panel needs the API. In another terminal:

```bash
cd ../api && yarn dev   # :3007
```

`config/development/hugo.toml` points the page at `http://127.0.0.1:3007` when
Hugo runs as a server, and `api/.env.dev` allows `:1313` as an origin. In
production both are one hostname behind nginx, `apiBase` is empty, the page
fetches the relative `/api/chat`, and there is no CORS at all.

## Where the copy lives

Nothing user-visible is in a template. Each section reads a data file:

| File                | Section                                          |
| ------------------- | ------------------------------------------------ |
| `data/nav.yaml`     | header links                                     |
| `data/hero.yaml`    | headline, lede, trust strip                      |
| `data/demo.yaml`    | the transcript that plays on load, offline lines |
| `data/metrics.yaml` | the ledger band                                  |
| `data/why.yaml`     | the three product columns                        |
| `data/pricing.yaml` | tiers                                            |
| `data/quotes.yaml`  | testimonials                                     |
| `data/band.yaml`    | the closing CTA                                  |
| `data/footer.yaml`  | badges and the disclaimer                        |

Editing copy means editing YAML; `assets/js/app.js` and `assets/css/main.css`
are fingerprinted static assets that don't change when the words do.

## Two things not to break

**The footer disclaimer** (`data/footer.yaml`, `fine:`) is the only text on the
site that isn't in character, and it's what a stranger in trouble reads. Don't
make it funnier and don't trim it to fit a layout.

**The offline lines** (`data/demo.yaml`, `offline:`) must never be training
rows. CLAUDE.md counts a verbatim echo of a seed as a failed run; a fallback
quoting seeds would disguise that failure as a success.

## The 404

`layouts/404.html`, copy in `data/notfound.yaml`. It reuses the hero grid and
the demo panel's chrome, so it introduces no new design. `assets/js/notfound.js`
rewrites the log line with the URL that actually 404'd — decoration only; the
page reads fine without it.

Hugo builds it to `public/404.html` but **nothing serves it automatically**.
nginx needs this inside the site's `server { }` block:

```nginx
error_page 404 /404.html;
location = /404.html { internal; }
```

Without that line a bad URL gets nginx's default grey 404, which is a different
company's 404.

## Before it goes live

The domain is **refusalgpt.cyou**. `baseURL` and the hostnames in `robots.txt`,
`security.txt`, `humans.txt`, and `llms.txt` all point at it.

- `security.txt` lists `security@pinecone.website` — a different domain, on
  purpose, because that mailbox exists and a `.cyou` one doesn't. Change it if
  you set up mail on the new domain; leave it if you don't. What it must never
  be is an address nobody reads.
- There's no `og:image`. The OG partial degrades to a summary card, which is
  fine, but a 1200×630 card would be better — and it matters more than usual
  here, because an unfurled card is what makes a `.cyou` link look deliberate
  rather than dubious.
- `.cyou` is a cheap TLD and sits on several abuse-heavy TLD lists, so links to
  it can get flagged or downranked by mail filters, Slack unfurlers, and some
  corporate DNS. Nothing to fix in this repo — just know why a link "doesn't
  work" for someone before you go debugging nginx.

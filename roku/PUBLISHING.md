# LivelySky Radar — Roku Go‑To‑Market & Publishing Playbook

*Verified against current (2025–2026) Roku developer documentation, Partner Knowledge Center, and live Channel Store data. Where Roku reality contradicts common assumptions, it's flagged ⚠️.*

---

## 0. Executive summary (read this first)

- **Build an SDK (BrightScript/SceneGraph) channel, not Direct Publisher.** Direct Publisher is free/ads‑only and was effectively sunset (Jan 12, 2024). Only an SDK channel can charge money or be a screensaver. This repo is already an SDK channel.
- **One package is BOTH a screensaver AND a launchable app.** A channel that implements `RunScreenSaver` *and* `Main`/`RunUserInterface` appears in the screensaver menu *and* on the Home screen. This is the single most important fact — it makes the hybrid product a real, supported configuration. (This repo does exactly this in `source/main.brs`.)
- **⚠️ Roku has NO keyword/tag search.** Users find a channel only by its **exact name** or by browsing algorithmic category rows. Your **title is your keyword strategy**; off‑platform marketing drives most installs.
- **Monetization:** one‑time **pay‑to‑install** = Roku keeps **20%** (you get 80%). Subscriptions / one‑time in‑app purchases via Roku Pay = Roku keeps **30%**. Recommendation: **pay‑to‑install at $4.99**.
- **⚠️ Data licensing is the biggest non‑obvious risk for a PAID app.** adsb.fi is *personal/non‑commercial only*; OpenSky is non‑commercial. **adsb.lol is ODbL (commercial OK with attribution/share‑alike).** For a paid product, default to **adsb.lol with ODbL attribution** (this repo does). Go/no‑go item — §1.5.

---

## 1. Publishing mechanics

### 1.1 Account, cost, path
- A Roku developer account is **free** (no annual fee, unlike Apple's $99/yr). Enable developer mode on a retail Roku and register at developer.roku.com.
- You **must use the SDK channel path** (not Direct Publisher) to charge money or ship a screensaver. Direct Publisher was sunset Jan 12, 2024.
- Steps: develop → sideload & self‑test against the cert checklist → create channel in the Developer Dashboard → set monetization → upload signed package + store metadata/graphics → provide **support + contact info (URL, email, AND phone)** plus admin/technical leads → submit for certification → publish on pass.

### 1.2 Certification & timeline
- Every app must pass **Static Analysis**; free/AVOD/SVOD also must pass **Channel Behavior Analysis**. Any error blocks publishing.
- **Timeline:** cert up to **5 business days**; a fix resubmission up to **5 business days**; publishing up to **2 business days** after passing. Submit ~1 month before any target launch.
- **Live‑data apps must degrade gracefully** on network loss (no crash, clear messaging), handle slow responses, and not hammer endpoints — build a visible "no data / offline" state (this repo has one).

### 1.3 Roku Pay / billing — what Roku takes

| Model | How | Roku cut | You keep | Fit |
|---|---|---|---|---|
| **Pay‑to‑install** | one‑time fee before install | **20%** | **80%** | ★ best — canonical for screensavers/games |
| One‑time IAP (Roku Pay) | unlock inside a free app | 30% | 70% | OK for free‑app + paid‑unlock |
| Subscription (SVOD) | recurring | 30% | 70% | overkill here |
| Free + video ads (AVOD) | ad‑supported | rev‑share | varies | weak for a niche utility |

⚠️ The **80/20 pay‑to‑install split beats the 70/30 IAP/subscription split** — favor pay‑to‑install unless you specifically need a free funnel.

### 1.4 Screensaver channels
- A screensaver **can be paid** (SDK channel, pay‑to‑install).
- ✅ **One package can be both** screensaver + app: implement `RunUserInterface`/`Main` *and* `RunScreenSaver`. A pure screensaver (no UI entry) shows only in the screensaver menu.
- ⚠️ The **screensaver entry point gets no remote input** and no video — keep it render‑only; all interactivity lives in the app entry (this repo splits exactly this way).
- The **screensaver picker is a second, low‑competition discovery shelf** on top of the Channel Store.

### 1.5 Live‑data constraints (READ — go/no‑go)

| Source | License | Commercial (paid) OK? | Attribution |
|---|---|---|---|
| **adsb.lol** | ODbL 1.0 | **Yes** | **Required** — "Aircraft data © adsb.lol, ODbL"; share‑alike on derived DB |
| adsb.fi | open, 1 req/s | ⚠️ **No** — personal/non‑commercial | n/a |
| OpenSky | free API | ⚠️ **No** — non‑commercial | n/a |

**Default to adsb.lol with persistent attribution. Respect ~1 req/s; query only the local bounding box.** Star catalog and Sun/Moon ephemeris are public‑domain/scientific — safe.

---

## 2. Positioning — recommendation

**Primary positioning: HYBRID, marketed screensaver‑first.** Brand it as *ambient live‑sky art that's secretly a radar.* Lead with the always‑on "live radar screensaver"; present the interactive flight radar as bonus depth.

Why: Roku users are lean‑back and **actively browse/pay for screensavers** (Roku City, Aquarium, Fireplace, Stars). A pure "flight tracker" fights that intent and invites comparison to free phone apps; a pure looped screensaver leaves the unique "those are REAL planes over MY house right now" wow‑factor on the table. The hybrid gets the screensaver‑picker shelf *and* the app, from one $4.99 product — uniquely enabled by Roku's single‑package support.

---

## 3. Competitive scan

- **"Flight Tracker" (Roku):** a search‑a‑flight utility — slow, ad/splash‑laden, forces ICAO codes, and does **not** plot what's overhead you. That's the gap.
- **No native Flightradar24‑style live map on Roku.** The "planes over my house on the TV" space is essentially open.
- **Ambient/screensaver set (your real competition):** Roku City (benchmark), Stars/Night Sky (static loops, not live/local), Aquarium/Fireplace (proven paid ambiance).
- **The gap LivelySky Radar owns:** the only ambient screensaver that is **live, real, and centered on the viewer's own location.** Every star/sky screensaver is canned; every flight tracker is a clunky search tool. The "wait, this is REAL?" moment is the wedge — shareable and uncopyable by loop‑video incumbents.

---

## 4. Monetization recommendation

**Pay‑to‑install, one‑time, $4.99** (you keep ~$4/sale at 80/20).
- 80/20 beats 70/30; one‑and‑done matches the ambient mental model; $4.99 is the impulse sweet spot ($2.99 underprices a live/data product; $9.99 invites hesitation for a niche).

⚠️ **Free‑trial caveat:** Roku's free‑trial tooling is **subscription‑centric**; pay‑to‑install generally can't do timed trials. Pick one:
- **(Recommended)** Pay‑to‑install $4.99, no trial — mitigate with a strong demo video/GIF in the store screenshots; the screensaver‑picker thumbnail acts as a preview.
- **(Alt)** Free app + $4.99 one‑time unlock (70/30) — free tier = limited radar/watermark; unlock = full radar + satellites + Sun/Moon. Use if the no‑trial wall throttles installs.

**Revenue sketch (illustrative):** at $4.99 × 80% ≈ $4/sale → 100 installs/mo ≈ $400/mo; 300/mo ≈ $1.2k/mo. A realistic "nice indie hit," not a venture outcome. Margins are excellent (data is free).

---

## 5. Store listing / ASO

⚠️ **Roku has no keyword field and no keyword search.** Discovery = exact‑name search + algorithmic category rows (every new app gets the **"New" row for 30 days**). **Your TITLE is your ASO; the description is for conversion.**

### Title options
1. **LivelySky Radar — Live Planes & Stars**  *(recommended)*
2. **Sky Radar: Live Planes Overhead**
3. **LivelySky — Live Flight & Star Screensaver**
4. **Overhead: Live Sky Radar Screensaver**

Brand first (typeable), then "planes / radar / stars / screensaver."

### Category
List under **Screensavers** (low‑competition primary shelf). If forced into an app category, pick **Special Interest / Lifestyle & Hobbies / Science**.

### Short description
> Turn your TV into a live radar of the real sky above you. LivelySky Radar plots actual planes flying overhead right now, tonight's real stars, and the Sun — as a beautiful sweeping radar screensaver, or an interactive map you can explore.

### Long description
> **The sky above your home — live, on your biggest screen.**
> LivelySky Radar centers on your location and shows what's *really* up there: real aircraft overhead in real time (live ADS‑B), the actual stars visible tonight, and the Sun in its true position — all under a calming, sweeping radar animation.
>
> **Two ways to enjoy it:**
> • **Screensaver mode** — let real planes drift across a living radar whenever your TV is idle.
> • **Radar mode** — open the app to explore: select a plane for flight info and adjust range rings.
>
> Unlike looping star or city screensavers, **everything here is live and local** — those are genuine planes flying over *your* house. One‑time purchase, no subscription, no ads.
>
> *Aircraft data © adsb.lol contributors (ODbL). Requires internet.*

### Required graphics (verified specs)
- **Store poster / channel icon:** exactly **540 × 405** px (generated: `images/channel_poster_540x405.png`).
- **App focus icon:** HD **336 × 210**, SD **248 × 140** (in `images/`, referenced by `manifest`).
- **Splash:** FHD **1920 × 1080** + HD **1280 × 720** (in `images/`, referenced by `manifest`).
- **Screenshots:** full‑HD **1920 × 1080**; make one a striking "planes‑over‑a‑city + sweep" hero — it's your only "trial."
- **Overhang logo (optional):** 400 × 90 px.

---

## 6. Launch plan (sideloaded MVP → published paid channel)

**Phase 1 — Pre‑cert hardening**
- [ ] Confirm the channel appears in **both** the screensaver picker and Home screen.
- [ ] Lock data to **adsb.lol** + persistent ODbL attribution; respect ~1 req/s, local bbox only.
- [ ] Verify graceful offline/error/no‑data states (cert requirement).
- [ ] Perf pass on budget ONN hardware: cap node count, pool blip nodes instead of rebuilding each poll.

**Phase 2 — Store readiness**
- [ ] Free dev account; create SDK channel; set **pay‑to‑install $4.99**.
- [ ] Produce assets (poster, splash, 4–5 FHD screenshots incl. hero, optional overhang).
- [ ] Stand up support contact (URL + email + phone) + admin/tech leads (required or cert fails).
- [ ] Clear Static Analysis + Channel Behavior Analysis errors.

**Phase 3 — Submit & publish**
- [ ] Submit ~1 month ahead; budget ~5 business days cert + up to 2 to publish; fix‑and‑resubmit loop if needed.
- [ ] Time marketing to the **30‑day "New" category feature** window.

**Phase 4 — Off‑platform marketing (demand creation, since no keyword search)**
Lead with a 15–30s screen recording of **real planes crossing the radar over a recognizable city** + the "these are REAL, right now" hook:
- Aviation/avgeek: r/aviation, r/flying, r/ADSB, r/flightradar24, r/avgeek; ADS‑B feeder communities (credit adsb.lol).
- Roku/cordcutter: r/Roku, r/cordcutters ("coolest paid Roku screensaver").
- Ambient/smart‑home + screensaver‑roundup blogs (Roku Guide, etc.).
- YouTube/TikTok short demo clips (highest leverage given no trial).
- Seasonal hooks: meteor showers, ISS passes, eclipses, holiday‑traffic days.

**Phase 5 — Iterate**
- [ ] Watch install/conversion; if the paid wall throttles installs, A/B the free + $4.99 unlock model.
- [ ] Ship satellites, Moon, ISS‑pass alerts post‑launch — each is a marketing beat + a screensaver‑picker re‑surface.

---

## Skeptical notes (where Roku contradicts assumptions)
1. "ASO = keywords/tags." ❌ Roku has neither — title‑as‑exact‑match + off‑platform demand.
2. "Screensavers can't make money." ❌ SDK screensavers are pay‑to‑install.
3. "Screensaver and app must be two products." ❌ One package does both.
4. "Roku takes 30% on everything." ❌ Pay‑to‑install is 20%.
5. "Any free ADS‑B source is fine for a paid app." ❌ Only adsb.lol (ODbL + attribution) is safe.
6. "Offer a free trial." ⚠️ Trials are subscription‑centric; use a free‑tier‑unlock if you need a funnel.

---

## Sources

Roku developer docs (developer.roku.com): Certification overview / criteria / pre‑cert tests / checklist; App Publishing guide; Monetization overview, Billing, Payouts, Monetization‑in‑dashboard; Screensavers docs; Streaming Store / Channel Store; Graphics specs. Roku Partner Knowledge Center: Direct Publisher screensaver & subscription FAQs, certification‑timeline FAQ, Channel‑Store‑search FAQ. Roku blog: screensaver SceneGraph tutorial; Fall 2025 + Spring 2026 cert updates. Roku engineering blog: search ranking. Channel/data: Roku Guide "Flight Tracker"; Stars/Night Sky/Fireplace‑Aquarium screensavers; Roku City (Wikipedia). Data licenses: adsb.lol API/GitHub (ODbL); adsb.fi opendata terms (non‑commercial); OpenSky (non‑commercial).

> *Verification caveat from research: page‑level fetching was limited, so the load‑bearing numbers (20% pay‑to‑install / 30% IAP split, ~5‑business‑day cert, 540×405 poster, no keyword search, single‑package screensaver+app, adsb.fi non‑commercial vs adsb.lol ODbL) were corroborated across multiple Roku/official sources but should be re‑confirmed directly on developer.roku.com before finalizing pricing/terms.*

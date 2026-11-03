import type { ReactNode } from "react";

/**
 * The drawing in the house ad: an ad struck out, the free plan's accounts, and
 * the two the paid plan adds, in one row of tiles across the bar.
 *
 * In a module of its own rather than in `ads.tsx`, because it is hidden from
 * assistive technology and the ad around it is not. The words beside it say
 * everything the picture does, so reading both aloud would say it twice; but
 * `ads.tsx` is held to containing no `aria-hidden` at all, since hiding an ad's
 * words is concealment, and a picture that carries the attribute inside that
 * file would make the check unable to tell the two apart.
 *
 * Two drawings rather than one, because the row has to give way where the bar
 * is narrow and a drawing cannot give way in the middle. The ad stands on its
 * own; the accounts are a strip held against the button, so when there is not
 * room for all of them the free plan's go first, under a fade at the strip's
 * left edge. What moves is at the right-hand end and is never what is cut.
 *
 * Painted by class from the stylesheet, never by a `fill` or `stroke`
 * attribute: an attribute cannot hold a token, so it would have one theme by
 * construction. The art tokens happen to be the same in both, because the bar
 * is a picture of a dark thing, and the classes keep it that way rather than
 * relying on it. No ids either, so nothing in it can collide with the page.
 *
 * Pose on the attribute, motion on a group inside it: a CSS `transform` on an
 * element replaces its `transform` attribute, so an animated group that also
 * held its own tilt would lose the tilt the moment it moved. The motion
 * classes do nothing until `HouseAd` arms them, so this is also the finished
 * picture wherever nothing does.
 */
export function HouseAdArt() {
  return (
    <div className="house-ad-art" aria-hidden="true">
      {/* The ad, part of the free plan's picture from the first frame, drawn
          in the sign-in panel's own units and scaled to a tile's height, so
          its strokes are the panel's. The dimmer comes before the strike in
          the document, so the strike stays bright over it, and fades in after
          the strike has drawn. */}
      <svg className="house-ad-banner" viewBox="0 0 62 58" focusable="false">
        <g transform="translate(31 31) rotate(-4) scale(0.29)">
          <rect className="house-ad-veil" x="-100" y="-66" width="200" height="132" rx="22" />
          <rect className="house-ad-veil" x="-80" y="-46" width="80" height="92" rx="12" />
          <circle className="house-ad-muted" cx="-56" cy="-22" r="9" />
          <path className="house-ad-stroke-muted" d="M-70 32-50 8l14 14 10-10 16 20" />
          <rect className="house-ad-muted" x="18" y="-40" width="62" height="14" rx="7" />
          <rect className="house-ad-muted" x="18" y="-16" width="44" height="14" rx="7" />
          <rect className="house-ad-muted" x="18" y="16" width="58" height="26" rx="13" />
          <rect
            className="house-ad-knockout house-ad-moves house-ad-dim"
            x="-100"
            y="-66"
            width="200"
            height="132"
            rx="22"
            opacity="0.5"
          />
          <path
            className="house-ad-stroke house-ad-moves house-ad-strike"
            pathLength={1}
            d="M-90 -56 90 56"
          />
        </g>
      </svg>

      <div className="house-ad-strip">
        <svg viewBox="0 0 250 58" focusable="false">
          <circle className="house-ad-orbit" cx="129" cy="31" r="44" />
          <circle className="house-ad-orbit" cx="129" cy="31" r="82" />

          {/* The free plan's accounts: a bank, a savings jar and a card.
              Already there, because they are what somebody on that plan has,
              and as many as that plan keeps in use. */}
          <g transform="translate(41 31) rotate(-3)">
            <AccountTile bar={18}>
              <path d="M3 9.5 12 4l9 5.5z" />
              <path d="M5.5 12.5v5M10 12.5v5M14 12.5v5M18.5 12.5v5" />
              <path d="M3 20.5h18" />
            </AccountTile>
          </g>
          <g transform="translate(85 30) rotate(3)">
            <AccountTile bar={13}>
              <path d="M7 3.5h10" />
              <path d="M8.5 3.5v2.3C6.6 7 5.5 8.8 5.5 11v7a3 3 0 0 0 3 3h7a3 3 0 0 0 3-3v-7c0-2.2-1.1-4-3-5.2V3.5" />
              <path d="M8.5 14.5h7" />
            </AccountTile>
          </g>
          <g transform="translate(129 31) rotate(-4)">
            <AccountTile bar={16}>
              <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
              <path d="M2.5 10h19M6.5 14.5h4" />
            </AccountTile>
          </g>

          {/* What the paid plan adds: two more drop in through the bar's top
              edge, at the end of the row. */}
          <g transform="translate(173 30) rotate(4)">
            <g className="house-ad-moves house-ad-arrive-first">
              <AccountTile bar={11}>
                <path d="M5 7.5 15.5 4l1.2 3.5" />
                <rect x="3" y="7.5" width="18" height="12.5" rx="2.5" />
                <path d="M21 11.5h-3.5a2 2 0 0 0 0 4H21" />
              </AccountTile>
            </g>
          </g>

          {/* The second hangs from the logo. The badge is pinned on its corner
              and sits outside the tile's own groups, so the tile sways under
              it while the badge stays put, and nothing moves anything else's
              target. */}
          <g transform="translate(217 31) rotate(-5)">
            <g className="house-ad-moves house-ad-arrive-second">
              <g className="house-ad-moves house-ad-sway">
                <AccountTile bar={15}>
                  <path d="M3.5 20h17" />
                  <path d="M4.5 16 9.5 11l3.5 3 6.5-7" />
                  <path d="M15 7h4.5v4.5" />
                </AccountTile>
              </g>
            </g>
            <g transform="translate(17 -16) rotate(11)">
              <g className="house-ad-moves house-ad-badge">
                <rect
                  className="house-ad-knockout"
                  x="-12.5"
                  y="-12.5"
                  width="25"
                  height="25"
                  rx="7"
                />
                <rect className="house-ad-mint" x="-11" y="-11" width="22" height="22" rx="6.16" />
                <g transform="translate(-7.04 -7.04) scale(0.5867)">
                  <g className="house-ad-glyph-on-mint">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
                    <path d="M12 18V6" />
                  </g>
                </g>
              </g>
            </g>
          </g>
        </svg>
      </div>
    </div>
  );
}

/**
 * One account, drawn the way every tile in the row is: a frosted tile, a
 * glyph on the logo's 24-unit grid at its two-unit stroke, and a mint bar
 * where a balance would be, so mint stays the one bright thing in the row.
 *
 * A bar rather than a figure or a name. A made-up balance beside somebody's
 * real ones is a number they might read as theirs, and words in a tile this
 * size would be a few pixels tall.
 */
function AccountTile({ bar, children }: { bar: number; children: ReactNode }) {
  return (
    <g className="house-ad-account">
      <rect className="house-ad-veil" x="-19" y="-19" width="38" height="38" rx="10" />
      <g transform="translate(-10 -14) scale(0.8333)">
        <g className="house-ad-glyph">{children}</g>
      </g>
      <rect className="house-ad-mint" x="-10" y="9" width={bar} height="4.5" rx="2.25" />
    </g>
  );
}

#!/usr/bin/env bash
# Copies the sprites we use out of the raw Game Dev Story dump into public/assets/gds
# and derives a few pieces (sky backdrop, carpet tile, "!" bubble). Needs ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
RAW=assets/raw/game-dev-story-graphics/graphics
OUT=public/assets/gds
SOUNDS=assets/raw/game-dev-story-sounds/game-dev-story-sounds
[[ -d "$RAW" ]] || { echo "No local artwork found. See docs/assets.md; proprietary artwork is not distributed with this project." >&2; exit 1; }
command -v convert >/dev/null 2>&1 || { echo "ImageMagick is required for local asset extraction." >&2; exit 1; }
# Preserve the tracked rights notice when regenerating the private runtime pack.
ASSET_NOTICE=$(mktemp)
trap 'rm -f "$ASSET_NOTICE"' EXIT
if [[ -f "$OUT/NOTICE.md" ]]; then cp "$OUT/NOTICE.md" "$ASSET_NOTICE"; fi
rm -rf "$OUT"; mkdir -p "$OUT"/{body,face,office,ui}
if [[ -s "$ASSET_NOTICE" ]]; then cp "$ASSET_NOTICE" "$OUT/NOTICE.md"; fi
cp "$RAW"/game/body*.png "$OUT/body/"
cp "$RAW"/game/face_*.png "$OUT/face/"
cp "$RAW"/office/desk_*.png "$RAW"/office/chair_*.png "$RAW"/office/pc_*.png "$RAW"/office/reception_*.png "$OUT/office/"
# the game's own composed desk reference: 3x3 of desk tier x orientation with the monitor,
# keyboard and mouse already on the desk. Our seat offsets are derived from its bottom row, and
# the sprite debug page shows it beside our build so the two can be compared.
cp "$RAW"/game/desk0_origin.png "$OUT/office/"
cp "$RAW"/game/{floorparts0,interface0,main00,main01,num7,fukidasi,bugbubble,jobtype}.png "$RAW"/kairolib_managed/{emoji,kairokun}.png "$OUT/ui/"
# sky + city silhouette from the top of the classic office backdrop
convert "$RAW/office/floor2.png" -crop 600x150+0+0 +repage "$OUT/ui/sky.png"
# carpet swatch (tiled in-game)
# Carpet tiles, one per theme, cut from a flat patch of each room sheet's own floor. The tile
# positions were found by scanning each room's interior for the 96x48 patch with the fewest
# distinct colours, so none of them carry a rug edge or a plant.
carpet() { convert "$RAW/office/$2.png" -crop 96x48+$3+$4 +repage "$OUT/ui/carpet_$1.png"; }
carpet classic  floor2  260 314
carpet woodshop floor11 228 298
carpet greenroom floor13 204 290
carpet tatami   floor0  254 300
# floor12's whole floor is a lit gradient, so a straight crop bands when tiled. Averaging the
# tile with its own flip and flop cancels the gradient and leaves the colour alone.
convert "$RAW/office/floor12.png" -crop 96x48+300+330 +repage \
  \( +clone -flip \) -compose blend -define compose:args=50 -composite \
  \( +clone -flop \) -compose blend -define compose:args=50 -composite "$OUT/ui/carpet_midnight.png"
carpet ice      floor19 300 330
carpet concrete floor21 292 282
carpet slate    floor34 248 288
carpet loft     floor36 252 322
cp "$OUT/ui/carpet_classic.png" "$OUT/ui/carpet.png"

# The tower each office stands on, cut from the real building under floor2's room. Its window grid
# follows the isometric, dropping 50px across 100px, and one storey is 50px tall — so a 100x50
# crop repeats as a plain rectangle and can be tiled straight onto each face with no shearing.
# Origins found by scoring every candidate for how well its edges wrap.
convert "$RAW/office/floor2.png" -crop 100x50+317+483 +repage /tmp/face_r.png   # lit face
convert "$RAW/office/floor2.png" -crop 100x50+59+476  +repage /tmp/face_l.png   # shaded face
facade() { convert /tmp/face_r.png -modulate $2 "$OUT/ui/facade_$1_r.png"; convert /tmp/face_l.png -modulate $2 "$OUT/ui/facade_$1_l.png"; }
facade classic   100,100,100
facade woodshop  112,110,98
facade greenroom 96,70,118
facade tatami    108,85,103
facade midnight  46,80,128
facade ice       104,45,128
facade concrete  98,12,100
facade slate     58,45,112
facade loft      116,88,101
# The work balloons: main01.png keeps eight of them in framed 46x39 cells, drawn on a solid panel
# colour that has to be keyed out. GameForm.DrawObj shows one above each dev via DrawFukidashi
# (HumanDexFukiIndex picks the cell) while they work. Order on the sheet:
#   0 gamepad burst (program)  1 "!" cloud  2 easel (graphics)  3 gramophone (sound)
#   4 bug net (debug)  5 burning book (scenario)  6 energy drink  7 magazines (promotion)
# Flood the panel colour away from the corner rather than keying it globally: the clouds are
# painted in a white two shades off the panel, and a global key punched holes through them.
cut_balloon() { # index x y panel   (x,y = the cell's top-left, on its frame line)
  local FRAME; FRAME=$(convert "$RAW/game/main01.png" -format '%[pixel:p{'$2','$3'}]' info:)
  if [[ "$1" == 0 ]]; then
    # The burst reaches beyond the other balloons' 40x36 crop. Keep all its points.
    # Its rays also split the grey frame into disconnected pieces, so remove that
    # colour throughout this cell before flooding away the surrounding panel.
    convert "$RAW/game/main01.png" -crop 43x37+$2+$3 +repage -alpha set -fuzz 6% \
      -transparent "$FRAME" -bordercolor "$4" -border 1 \
      -fill none -floodfill +0+0 "$4" \
      -shave 1x1 -trim +repage -define png:color-type=6 "$OUT/ui/balloon_$1.png"
    return
  fi
  # eat the frame ring from the corner, then the panel from each inner corner (one corner may be
  # under the art: the gramophone's notes reach the top-left). The clouds' grey outlines sit well
  # outside 6% of either colour, so the fill stops at them. Always write RGBA: a cell that keyed
  # nothing would otherwise be saved as an opaque palette PNG.
  convert "$RAW/game/main01.png" -crop 40x36+$2+$3 +repage -bordercolor "$FRAME" -border 1 -alpha set -fuzz 6% \
    -fill none -floodfill +0+0 "$FRAME" \
    -fill none -floodfill +2+2 "$4" -fill none -floodfill +39+2 "$4" -fill none -floodfill +2+35 "$4" -fill none -floodfill +39+35 "$4" \
    -shave 1x1 -trim +repage -define png:color-type=6 "$OUT/ui/balloon_$1.png"
}
P1=$(convert "$RAW/game/main01.png" -format '%[pixel:p{51,101}]' info:)    # row 1 panel, sampled inside the "!" cell
P2=$(convert "$RAW/game/main01.png" -format '%[pixel:p{5,140}]' info:)     # row 2 panel
i=0; for x in 2 48 94 140 186; do cut_balloon $i $x 98 "$P1"; i=$((i+1)); done
# the second row's boxes carry a double ring (lavender highlight over grey), which a corner flood
# cannot get through; crop those from just inside the frame instead (37x33 at +3,+2 of the box)
cut_inner() { # index x y panel
  convert "$RAW/game/main01.png" -crop 37x33+$2+$3 +repage -bordercolor "$4" -border 1 -alpha set -fuzz 6% \\
    -fill none -floodfill +0+0 "$4" -shave 1x1 -trim +repage -define png:color-type=6 "$OUT/ui/balloon_$1.png"
}
for x in 5 51 97; do cut_inner $i $x 139 "$P2"; i=$((i+1)); done
cp "$OUT/ui/balloon_1.png" "$OUT/ui/bang.png"   # the "!" cloud, kept under its old name
echo "assets written to $OUT"; du -sh "$OUT"

# the keyboard the game does not draw for a monitor seen from behind (see the script's header)
node "$(dirname "$0")/make-keyboard.mjs"
# office props, cut out of the room sheets. This runs here because the wipe above takes the whole
# of $OUT with it, decor and all.
node "$(dirname "$0")/extract-decor.js"

# Celebration art. event0.png is the game's own "you shipped it" scene: a row of staff with their
# arms up, one flat on their back, and a field of confetti under them. main01 carries the trophy.
mkdir -p "$OUT/celebrate"
convert "$RAW/game/event0.png" -crop 29x44+3+81   +repage "$OUT/celebrate/cheer_0.png"
convert "$RAW/game/event0.png" -crop 58x42+36+83  +repage "$OUT/celebrate/cheer_1.png"   # arms spread
convert "$RAW/game/event0.png" -crop 58x47+98+81  +repage "$OUT/celebrate/cheer_2.png"   # arms spread
convert "$RAW/game/event0.png" -crop 29x45+165+80 +repage "$OUT/celebrate/cheer_3.png"
# left of x=153, where the figure lying on their back would otherwise be tiled in too
convert "$RAW/game/event0.png" -crop 150x34+0+137 +repage "$OUT/celebrate/confetti.png"
# The full cup includes the rim at y=177 and the handle outline at x=15.
convert "$RAW/game/main01.png" -crop 16x16+0+177  +repage "$OUT/celebrate/trophy.png"

# Cutscene art. The remaining event scenes: the crunch office and its haggard portraits (event1),
# the launch-day shop front and the queue of fans (event3), the GAMEDEX hall, its sign and the
# crowd (event4), the awards auditorium and the two presenters (event5), the explosion frames
# (event6), the training room and its progress bar (event7), and the ranking board (event8).
mkdir -p "$OUT/scenes"
convert "$RAW/game/event1.png" -crop 200x81+0+0    +repage "$OUT/scenes/crunch_room.png"
convert "$RAW/game/event1.png" -crop 192x42+4+83   +repage "$OUT/scenes/crunch_faces.png"
convert "$RAW/game/event3.png" -crop 200x81+0+0    +repage "$OUT/scenes/shop_front.png"
convert "$RAW/game/event3.png" -crop 200x43+0+81   +repage "$OUT/scenes/shop_queue.png"
convert "$RAW/game/event3.png" -crop 33x50+200+0   +repage "$OUT/scenes/shop_sign.png"
convert "$RAW/game/event4.png" -crop 240x167+0+0   +repage "$OUT/scenes/expo_hall.png"
convert "$RAW/game/event4.png" -crop 188x27+0+168  +repage "$OUT/scenes/expo_sign.png"
convert "$RAW/game/event4.png" -crop 200x31+0+196  +repage "$OUT/scenes/expo_crowd.png"
convert "$RAW/game/event5.png" -crop 240x171+0+0   +repage "$OUT/scenes/awards_hall.png"
convert "$RAW/game/event5.png" -crop 46x22+0+172   +repage "$OUT/scenes/awards_hosts.png"
convert "$RAW/game/event6.png" -crop 26x28+12+14   +repage "$OUT/scenes/boom_0.png"
convert "$RAW/game/event6.png" -crop 50x48+51+2    +repage "$OUT/scenes/boom_1.png"
convert "$RAW/game/event6.png" -crop 46x28+105+2   +repage "$OUT/scenes/boom_2.png"
convert "$RAW/game/event7.png" -crop 201x109+0+0   +repage "$OUT/scenes/training_room.png"
convert "$RAW/game/event7.png" -crop 165x17+0+110  +repage "$OUT/scenes/training_bar.png"
cp "$RAW/game/event8.png" "$OUT/scenes/ranking_board.png"

# The HUD bar: the game's own status strip, the tall silver band of interface0 (y 23..63). The band
# is drawn 240 wide with a sheen down its left half, and everything from x=117 rightwards is one
# repeated column with a 10px cap at the end. Rebuilt here as a three-slice — cap, one repeating
# column, mirrored cap — so CSS border-image can stretch it to any width without smearing the
# sheen across the panel.
convert "$RAW/game/interface0.png" -crop 10x41+230+23 +repage "$OUT/ui/_cap.png"
convert "$RAW/game/interface0.png" -crop  1x41+200+23 +repage "$OUT/ui/_mid.png"
convert \( "$OUT/ui/_cap.png" -flop \) "$OUT/ui/_mid.png" "$OUT/ui/_cap.png" +append +repage "$OUT/ui/hud_bar.png"
rm -f "$OUT/ui/_cap.png" "$OUT/ui/_mid.png"

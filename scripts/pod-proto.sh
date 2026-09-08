#!/usr/bin/env bash
# Compose a 4-desk pod from the raw sheets for side-by-side comparison with the game.
# usage: pod-proto.sh out.png "<seatA>" "<seatB>" "<seatC>" "<seatD>"
# seat = "deskFrame,deskX,deskY,pcFrame,pcFlip,pcX,pcY,chairFrame,chairFlip,chairX,chairY,bodyFrameY,bodyFlip,faceX,personX,personY,order"
# frames: desk 0/1 ; pc 0=back 1=on0 ; chair 0..3 ; bodyFrameY 16 (front) or 0 col3 (back) ; order e.g. cpdm (chair,person,desk,monitor) back->front
set -e
G=assets/raw/game-dev-story-graphics/graphics; B=$G/game/body0.png; F=$G/game/face_0.png
out=$1; shift
cmd=(convert -size 180x150 xc:'#8a5a3c' +size)
for seat in "$@"; do
  IFS=, read df dx dy pf pflip px py cf cflip cx cy by bflip fx ppx ppy order <<< "$seat"
  layers=()
  for o in $(echo "$order" | grep -o .); do
    case $o in
      d) layers+=("(" $G/office/desk_002.png -crop 50x64+$((df*50))+0 +repage ")" -geometry +${dx}+${dy} -composite);;
      m) fl=""; [ "$pflip" = 1 ] && fl="-flop"; layers+=("(" $G/office/pc_001.png -crop 50x32+$((pf*50))+0 +repage $fl ")" -geometry +${px}+${py} -composite);;
      c) fl=""; [ "$cflip" = 1 ] && fl="-flop"; layers+=("(" $G/office/chair_002.png -crop 21x32+$((cf*21))+0 +repage $fl ")" -geometry +${cx}+${cy} -composite);;
      p) fl=""; [ "$bflip" = 1 ] && fl="-flop"; bx=0; [ "$by" = 0 ] && bx=51
         layers+=("(" $B -crop 17x17+${bx}+${by} +repage $fl ")" -geometry +${ppx}+${ppy} -composite "(" $F -crop 16x15+${fx}+0 +repage $fl ")" -geometry +${ppx}+$((ppy-4)) -composite);;
    esac
  done
  cmd+=("${layers[@]}")
done
cmd+=(-filter point -resize 400% "$out")
"${cmd[@]}"

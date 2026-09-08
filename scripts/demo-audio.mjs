// Original, gently plucked chiptune bed for the recorded demo. No sampled game soundtrack.
import { writeFileSync } from 'node:fs';
export function writeDemoAudio(path, seconds = 30) {
  const rate = 44100, samples = new Float32Array(Math.ceil(seconds * rate));
  const hz = note => 440 * 2 ** ((note - 69) / 12);
  function pluck(at, length, note, gain, bright = false) {
    const start = Math.floor(at * rate), count = Math.floor(length * rate), frequency = hz(note);
    for (let i = 0; i < count && start + i < samples.length; i++) {
      const t = i / rate, phase = t * frequency;
      const wave = Math.sin(2 * Math.PI * phase) + (bright ? .24 : .1) * Math.sin(6 * Math.PI * phase);
      const envelope = Math.min(1, t / .012) * Math.exp(-t * (bright ? 7 : 4)) * Math.min(1, (length - t) / .045);
      samples[start + i] += wave * gain * envelope;
    }
  }
  const beat = 60 / 112;
  const chords = [[60,64,67,71], [57,60,64,67], [53,57,60,64], [55,59,62,67]];
  for (let bar = 0; bar * beat * 4 < seconds; bar++) {
    const chord = chords[bar % chords.length], at = bar * beat * 4;
    for (let step = 0; step < 8; step++) pluck(at + step * beat / 2, .65, chord[[0,2,1,3,2,1,3,2][step]] + 12, .045, true);
    pluck(at, 1.1, chord[0] - 12, .075);
    pluck(at + 2 * beat, .85, chord[2] - 12, .055);
  }
  // Small punctuation for the question and the completion.
  [76,79].forEach((note,i) => pluck(7.1 + i*.15,.6,note,.07,true));
  [72,76,79,84].forEach((note,i) => pluck(17.1+i*.12,1,note,.085,true));
  [79,84,88].forEach((note,i) => pluck(21.1+i*.1,1,note,.06,true));
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i=0;i<samples.length;i++) {
    const t=i/rate, fade=Math.min(1,t/.6,(seconds-t)/1.3);
    pcm.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]*fade)) * 32767),i*2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF',0);header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  writeFileSync(path,Buffer.concat([header,pcm]));
}

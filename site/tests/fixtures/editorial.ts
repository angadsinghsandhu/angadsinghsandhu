import type { MusicRelease, Project } from "../../src/content/editorial";

export const projects: readonly Project[] = [
  {
    title: "Fixture project",
    slug: "fixture-project",
    summary: "An entry for testing the Projects detail route.",
    status: "approved",
    body: ["Project detail fixture."],
    links: [],
  },
  {
    title: "Draft project",
    slug: "draft-project",
    summary: "An unpublished entry for testing editorial visibility.",
    status: "draft",
    body: [],
    links: [],
  },
];

const cover = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#391f45" d="M0 0h100v100H0z"/>
  <path stroke="#f9a461" stroke-width="2" d="M0 65l100-50M0 78l100-50M0 91l100-50"/>
</svg>`;

export const releases: readonly MusicRelease[] = [
  {
    title: "Fixture release",
    slug: "fixture-release",
    summary: "A sample used to test playback on request.",
    status: "approved",
    cover: {
      src: `data:image/svg+xml,${encodeURIComponent(cover)}`,
      alt: "Amber and violet fixture cover",
    },
    embedUrl: "/fixtures/audio/",
    providers: [],
    tracks: ["Test tone · 0:01"],
    credits: [{ role: "Audio", name: "Synthesized test tone" }],
  },
];

export function testTone() {
  const samples = 8000;
  const wave = Buffer.alloc(44 + samples);
  wave.write("RIFF");
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(samples, 24);
  wave.writeUInt32LE(samples, 28);
  wave.writeUInt16LE(1, 32);
  wave.writeUInt16LE(8, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(samples, 40);
  for (let index = 0; index < samples; index++) {
    wave[44 + index] =
      128 + Math.round(25 * Math.sin((2 * Math.PI * 440 * index) / samples));
  }
  return `data:audio/wav;base64,${wave.toString("base64")}`;
}

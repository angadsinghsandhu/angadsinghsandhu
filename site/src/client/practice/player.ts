import {
  createPlayback,
  type PlaybackController,
  type PlaybackState,
} from "./playback";
import { renderTraceFrame } from "./renderers";
import type { AlgorithmTrace, TraceFrame } from "./trace-model";

type Transcript = {
  exampleId: string;
  steps: Pick<TraceFrame, "stepId" | "explanation" | "codeLines">[];
};

type LessonTrace = {
  problemId: string;
  approachId: string;
  implementationSha256: string;
  transcripts: Transcript[];
};

export function assertTraceMatchesLesson(
  traces: AlgorithmTrace[],
  lesson: LessonTrace,
  codeLines: ReadonlySet<number>,
): void {
  if (traces.length !== lesson.transcripts.length)
    throw new Error("Trace does not match the published transcripts");

  for (const [index, trace] of traces.entries()) {
    const transcript = lesson.transcripts[index]!;
    if (
      trace.problemId !== lesson.problemId ||
      trace.approachId !== lesson.approachId ||
      trace.implementationSha256 !== lesson.implementationSha256 ||
      trace.exampleId !== transcript.exampleId ||
      trace.frames.length !== transcript.steps.length
    )
      throw new Error("Trace does not match the published transcript");

    for (const [stepIndex, frame] of trace.frames.entries()) {
      const step = transcript.steps[stepIndex]!;
      if (
        frame.stepId !== step.stepId ||
        frame.explanation.trim() !== step.explanation ||
        frame.codeLines.length !== step.codeLines.length ||
        frame.codeLines.some((line, index) => line !== step.codeLines[index])
      )
        throw new Error("Trace frame does not match the published transcript");

      if (frame.codeLines.some((line) => !codeLines.has(line)))
        throw new Error("Trace references an absent published code line");
    }
  }
}

function readPublishedTranscript(approach: HTMLElement) {
  const lists = Array.from(
    approach.querySelectorAll<HTMLElement>("[data-practice-example]"),
  );
  const steps = lists.map((list) =>
    Array.from(list.querySelectorAll<HTMLElement>("[data-practice-step]")),
  );
  const transcripts = steps.map((items, index): Transcript => ({
    exampleId: lists[index]!.dataset.practiceExample!,
    steps: items.map((item) => ({
      stepId: item.dataset.practiceStep!,
      explanation:
        item.querySelector("[data-practice-explanation]")?.textContent.trim() ??
        "",
      codeLines: Array.from(
        item.querySelectorAll<HTMLElement>("[data-practice-step-line]"),
        (line) => Number(line.dataset.practiceStepLine),
      ),
    })),
  }));

  return { transcripts, steps };
}

export function mountTracePlayer(root: HTMLElement): void {
  const approach = root.closest<HTMLElement>("[data-practice-approach]");
  if (!approach) return;

  const load = root.querySelector<HTMLButtonElement>("[data-player-load]")!;
  const status = root.querySelector<HTMLElement>("[data-player-status]")!;
  const panel = root.querySelector<HTMLElement>("[data-player-panel]")!;
  const controls = root.querySelector<HTMLElement>("[data-player-controls]")!;
  const previous = root.querySelector<HTMLButtonElement>(
    "[data-player-previous]",
  )!;
  const next = root.querySelector<HTMLButtonElement>("[data-player-next]")!;
  const play = root.querySelector<HTMLButtonElement>("[data-player-play]")!;
  const reset = root.querySelector<HTMLButtonElement>("[data-player-reset]")!;
  const example = root.querySelector<HTMLSelectElement>(
    "[data-player-example]",
  )!;
  const speed = root.querySelector<HTMLSelectElement>("[data-player-speed]")!;
  const stepLabel = root.querySelector<HTMLElement>("[data-player-step]")!;
  const explanation = root.querySelector<HTMLElement>(
    "[data-player-explanation]",
  )!;
  const activeLines = root.querySelector<HTMLElement>(
    "[data-player-code-lines]",
  )!;
  const snapshot = root.querySelector<HTMLElement>("[data-player-state]")!;
  const document = root.ownerDocument;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const playbackUnavailable = root.querySelector<HTMLElement>(
    "[data-player-motion-note]",
  )!;
  let controller: PlaybackController;
  let autoplayVisible = false;

  const setUnavailable = (button: HTMLButtonElement, disabled: boolean) =>
    button.setAttribute("aria-disabled", String(disabled));

  function updateControls(state: PlaybackState) {
    setUnavailable(previous, state.index === 0);
    setUnavailable(next, state.index === state.total - 1);
    setUnavailable(
      play,
      reducedMotion.matches || state.index === state.total - 1,
    );
    play.textContent = state.playing ? "Pause" : "Play";
    playbackUnavailable.hidden = !reducedMotion.matches;
  }

  function bindTraceControls(
    traces: AlgorithmTrace[],
    published: ReturnType<typeof readPublishedTranscript>,
    code: Map<number, HTMLElement>,
  ) {
    let markedLines: HTMLElement[] = [];
    let markedStep: HTMLElement | undefined;
    let lastFrame: TraceFrame | undefined;

    function render(state: PlaybackState): void {
      updateControls(state);
      const frame = controller.getFrame();
      if (frame === lastFrame) return;
      lastFrame = frame;
      stepLabel.dataset.playerStep = frame.stepId;
      stepLabel.textContent = `Step ${state.index + 1} of ${state.total}`;
      explanation.textContent = frame.explanation;
      activeLines.textContent = `Code ${frame.codeLines.length === 1 ? "line" : "lines"} ${frame.codeLines.join(", ")}`;
      renderTraceFrame(snapshot, frame);

      for (const line of markedLines)
        line.classList.remove("trace-current-line");
      markedLines = frame.codeLines.map((line) => code.get(line)!);
      for (const line of markedLines) line.classList.add("trace-current-line");

      markedStep?.removeAttribute("aria-current");
      markedStep = published.steps[example.selectedIndex]![state.index]!;
      markedStep.setAttribute("aria-current", "step");
    }

    function selectExample() {
      controller?.destroy();
      controller = createPlayback(traces[example.selectedIndex]!, render);
      controller.setSpeed(Number(speed.value));
      render(controller.getState());
    }

    previous.addEventListener("click", () => {
      if (previous.getAttribute("aria-disabled") !== "true")
        controller.previous();
    });
    next.addEventListener("click", () => {
      if (next.getAttribute("aria-disabled") !== "true") controller.next();
    });
    reset.addEventListener("click", () => controller.reset());
    example.addEventListener("change", selectExample);
    speed.addEventListener("change", () =>
      controller.setSpeed(Number(speed.value)),
    );
    play.addEventListener("click", () => {
      if (controller.getState().playing) controller.pause();
      else if (!reducedMotion.matches && !document.hidden && autoplayVisible)
        controller.play();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) controller.pause();
    });
    window.addEventListener("pagehide", () => controller.pause());
    reducedMotion.addEventListener("change", () => {
      if (reducedMotion.matches) controller.pause();
      updateControls(controller.getState());
    });

    new IntersectionObserver(([entry]) => {
      autoplayVisible = Boolean(entry?.isIntersecting);
      if (!autoplayVisible) controller.pause();
    }).observe(controls);

    selectExample();
  }

  async function activate() {
    if (load.getAttribute("aria-disabled") === "true") return;
    setUnavailable(load, true);
    status.textContent = "Loading interactive trace…";
    const signal = AbortSignal.timeout(5_000);
    const deadline = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    try {
      const { loadTracePackage } = await Promise.race([
        import("./trace"),
        deadline,
      ]);
      const traces = await loadTracePackage(
        {
          url: root.dataset.traceUrl!,
          sha256: root.dataset.traceSha256!,
          bytes: Number(root.dataset.traceBytes),
          exampleIds: Array.from(example.options, (option) => option.value),
        },
        signal,
      );
      const published = readPublishedTranscript(approach!);
      const code = new Map(
        Array.from(
          approach!.querySelectorAll<HTMLElement>(
            "[data-practice-code] [data-practice-line]",
          ),
          (line) => [Number(line.dataset.practiceLine), line],
        ),
      );
      assertTraceMatchesLesson(
        traces,
        {
          problemId: root.dataset.problemId!,
          approachId: root.dataset.approachId!,
          implementationSha256: root.dataset.implementationSha256!,
          transcripts: published.transcripts,
        },
        new Set(code.keys()),
      );

      bindTraceControls(traces, published, code);
      panel.hidden = false;
      if (document.activeElement === load) example.focus();
      load.hidden = true;
      status.textContent = "";
    } catch (error) {
      setUnavailable(load, false);
      status.textContent =
        error instanceof DOMException && error.name === "TimeoutError"
          ? "The interactive trace took too long. Try again or read the transcript below."
          : "Could not load the interactive trace. Try again or read the transcript below.";
    }
  }

  load.addEventListener("click", () => void activate());
  load.hidden = false;
}

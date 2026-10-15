import { useEffect, useLayoutEffect, useRef, type Dispatch, type MouseEvent, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, RotateCcw, Volume2 } from 'lucide-react';
import { EntryContent } from './entry-content';
import { ui, type Locale } from './i18n';
import { practiceCounts, type ActivePractice, type PracticeAction, type PracticeCardIdentity, type PracticeRating } from './practice';
import { hasVerticalIntent, swipeDirection, type SwipePoint } from './practice-swipe';

type Gesture = { pointerId: number; start: SwipePoint; identity: PracticeCardIdentity };
type FocusStep = Pick<ActivePractice, 'session' | 'round' | 'phase' | 'index'> & { revealed: boolean };

const interactive = 'button, a, input, textarea, select, summary, [role="button"], [contenteditable]';
const hasSelection = () => window.getSelection()?.isCollapsed === false;
const point = (event: PointerEvent): SwipePoint => ({ x: event.clientX, y: event.clientY, time: event.timeStamp });

export function PracticePanel({ state, locale, dispatch, onExit, onSpeak }: {
  state: ActivePractice;
  locale: Locale;
  dispatch: Dispatch<PracticeAction>;
  onExit: () => void;
  onSpeak: (word: string) => void;
}) {
  const text = ui[locale];
  const prompt = useRef<HTMLHeadingElement>(null);
  const answer = useRef<HTMLHeadingElement>(null);
  const result = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<FocusStep | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const { session, round, revision, phase, index } = state;
  const entry = state.cards[index];
  const { revealed, rating } = state.progress[index];
  const counts = practiceCounts(state);
  const identity = { session, round, revision };
  const cardIdentity = { ...identity, entryId: entry.id };
  const ratingLabel = rating === 'recalled' ? text.recalledCorrectly
    : rating === 'missed' ? text.didNotRecall : text.practiceUnrated;
  const ratingStatus = <p id="practice-rating-status" className="practice-rating-status">{text.practiceCurrentRating(ratingLabel)}</p>;

  useLayoutEffect(() => {
    const previous = previousFocus.current;
    const justRevealed = phase === 'card' && previous?.phase === 'card'
      && previous.session === session && previous.round === round && previous.index === index
      && !previous.revealed && revealed;
    const target = phase === 'summary' ? result.current : justRevealed ? answer.current : prompt.current;
    target?.focus();
    previousFocus.current = { session, round, phase, index, revealed };
    gesture.current = null;
  }, [session, round, revision, phase, index, revealed]);

  useEffect(() => {
    const selectionChanged = () => { if (hasSelection()) gesture.current = null; };
    const anotherTouch = (event: globalThis.PointerEvent) => {
      if (event.pointerType === 'touch' && gesture.current?.pointerId !== event.pointerId)
        gesture.current = null;
    };
    document.addEventListener('selectionchange', selectionChanged);
    document.addEventListener('pointerdown', anotherTouch, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', selectionChanged);
      document.removeEventListener('pointerdown', anotherTouch);
    };
  }, []);

  function cancelGesture() {
    gesture.current = null;
  }

  function beginGesture(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== 'touch') return;
    if (!event.isPrimary || gesture.current) { cancelGesture(); return; }
    if (!(event.target instanceof Element) || event.target.closest(interactive) || hasSelection()) return;
    gesture.current = { pointerId: event.pointerId, start: point(event), identity: cardIdentity };
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (hasVerticalIntent(active.start, point(event)) || event.timeStamp - active.start.time > 700 || hasSelection())
      cancelGesture();
  }

  function endGesture(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    cancelGesture();
    if (hasSelection()) return;
    const direction = swipeDirection(active.start, point(event));
    if (direction) dispatch({ type: 'navigate', ...active.identity, direction });
  }

  function rate(event: MouseEvent<HTMLButtonElement>, value: PracticeRating) {
    // A revisited next card may already show these buttons when a double-click lands.
    if (event.detail > 1) return;
    dispatch({ type: 'rate', ...cardIdentity, rating: value });
  }

  return (
    <section className="practice" aria-label={text.practiceTitle}>
      <div className="practice-toolbar">
        <span>{text.practiceTitle}</span>
        <button className="text-button" onClick={onExit}><ArrowLeft size={16} />{text.endPractice}</button>
      </div>
      {phase === 'summary' ? (
        <div className="practice-result">
          <h1 ref={result} tabIndex={-1} aria-describedby="practice-result-count practice-result-breakdown">
            {counts.unrated ? text.practiceSummary : text.practiceComplete}
          </h1>
          <p id="practice-result-count" className="practice-result-count">
            {text.practiceResult(counts.recalled, state.cards.length)}
          </p>
          <dl id="practice-result-breakdown" className="practice-result-breakdown">
            <div><dt>{text.recalledCorrectly}</dt><dd>{counts.recalled}</dd></div>
            <div><dt>{text.didNotRecall}</dt><dd>{counts.missed}</dd></div>
            <div><dt>{text.practiceUnrated}</dt><dd>{counts.unrated}</dd></div>
          </dl>
          <p>{counts.unrated ? text.practiceUnratedRemaining(counts.unrated)
            : counts.missed ? text.practiceMisses(counts.missed) : text.practiceAllRecalled}</p>
          <div className="practice-actions">
            {counts.unrated === 0 && counts.missed > 0 && (
              <button className="primary" onClick={() => dispatch({ type: 'retry', ...identity })}>
                <RotateCcw size={16} />{text.retryMissed}
              </button>
            )}
            <button className={counts.unrated ? 'primary' : 'secondary'} onClick={() => dispatch({ type: 'resume', ...identity })}>
              {counts.unrated ? text.continueUnrated : text.reviewRound}
            </button>
            <button className={counts.unrated === 0 && counts.missed === 0 ? 'primary' : 'secondary'} onClick={onExit}>{text.backToWords}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="practice-navigation" role="group" aria-label={text.practiceNavigation}>
            <button className="secondary" aria-label={text.previousWord} disabled={index === 0}
              onClick={() => dispatch({ type: 'navigate', ...cardIdentity, direction: 'previous' })}>
              <ArrowLeft size={16} aria-hidden="true" /><span className="practice-navigation-label">{text.previousWord}</span>
            </button>
            <p id="practice-progress" className="practice-progress">
              <span>{text.practiceProgress(index + 1, state.cards.length)}</span>
              <span>{text.practiceRated(state.cards.length - counts.unrated, state.cards.length)}</span>
            </p>
            <button className="secondary" aria-label={text.nextWord} disabled={index === state.cards.length - 1}
              onClick={() => dispatch({ type: 'navigate', ...cardIdentity, direction: 'next' })}>
              <span className="practice-navigation-label">{text.nextWord}</span><ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="practice-card" onPointerDown={beginGesture} onPointerMove={moveGesture}
            onPointerUp={endGesture} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}
            onContextMenu={cancelGesture}>
            <div className="practice-word">
              <h1 ref={prompt} tabIndex={-1} aria-describedby="practice-progress practice-instruction practice-rating-status"><span lang="en">{entry.word}</span></h1>
              <button className="sound" aria-label={text.speak(entry.word)} onClick={() => onSpeak(entry.word)}>
                <Volume2 size={20} />
              </button>
            </div>
            <p id="practice-instruction" className="practice-instruction">{text.practicePrompt}</p>
            {!revealed ? (
              <>
                {ratingStatus}
                <button className="primary reveal-answer" onClick={() => dispatch({ type: 'reveal', ...cardIdentity })}>
                  {text.showAnswer}
                </button>
              </>
            ) : (
              <div className="practice-answer">
                <h2 ref={answer} tabIndex={-1}>{text.savedAnswer}</h2>
                <EntryContent entry={entry} locale={locale} beforeMetadata={
                  <>
                    {ratingStatus}
                    <div className="practice-actions" role="group" aria-label={text.rateRecall}>
                      <button className="secondary" aria-pressed={rating === 'missed'} onClick={event => rate(event, 'missed')}>
                        {text.didNotRecall}
                      </button>
                      <button className="primary" aria-pressed={rating === 'recalled'} onClick={event => rate(event, 'recalled')}>
                        <Check size={16} />{text.recalledCorrectly}
                      </button>
                    </div>
                    <p className="field-hint">{text.practiceRatingHint}</p>
                  </>
                } />
              </div>
            )}
          </div>
          <button className="text-button practice-view-results" onClick={() => dispatch({ type: 'view-results', ...cardIdentity })}>
            {text.viewPracticeResults}
          </button>
          <p className="field-hint">{text.practiceNavigationHint}</p>
        </>
      )}
      <p className="practice-note">{text.practiceSessionOnly}</p>
    </section>
  );
}

export function createIdleTabScheduler({
  timeoutMs,
  onIdle,
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let activeCalls = 0;
  let generation = 0;
  let timer;

  function clearScheduledTimer() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function schedule() {
    if (timeoutMs <= 0 || activeCalls > 0) return;
    const scheduledGeneration = ++generation;
    timer = setTimer(() => {
      timer = undefined;
      if (activeCalls > 0 || scheduledGeneration !== generation) return;
      void Promise.resolve(onIdle()).catch(onError);
    }, timeoutMs);
    timer?.unref?.();
  }

  return {
    begin() {
      activeCalls += 1;
      generation += 1;
      clearScheduledTimer();
    },
    end() {
      if (activeCalls <= 0) throw new Error("Idle tab scheduler activity underflow.");
      activeCalls -= 1;
      if (activeCalls === 0) schedule();
    },
    cancel() {
      activeCalls = 0;
      generation += 1;
      clearScheduledTimer();
    },
    get activeCalls() {
      return activeCalls;
    },
  };
}


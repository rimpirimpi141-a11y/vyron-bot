/**
 * Lightweight state manager for multi-step bot conversations and navigation history
 */
class StateManager {
  constructor() {
    this.states = new Map();
    this.navStacks = new Map();
  }

  set(telegramId, stateData) {
    this.states.set(String(telegramId), {
      ...stateData,
      updatedAt: Date.now()
    });
  }

  get(telegramId) {
    const state = this.states.get(String(telegramId));
    if (!state) return null;
    // Timeout after 15 minutes of inactivity
    if (Date.now() - state.updatedAt > 15 * 60 * 1000) {
      this.clear(telegramId);
      return null;
    }
    return state;
  }

  clear(telegramId) {
    this.states.delete(String(telegramId));
  }

  pushNav(telegramId, screen) {
    const tid = String(telegramId);
    let stack = this.navStacks.get(tid);
    if (!stack || !Array.isArray(stack)) {
      stack = ['four_button'];
    }
    if (stack[stack.length - 1] !== screen) {
      stack.push(screen);
    }
    if (stack.length > 20) stack.shift(); // Keep reasonable depth
    this.navStacks.set(tid, stack);
  }

  popNav(telegramId) {
    const tid = String(telegramId);
    let stack = this.navStacks.get(tid);
    if (!stack || !Array.isArray(stack) || stack.length <= 1) {
      this.navStacks.set(tid, ['four_button']);
      return 'four_button';
    }
    stack.pop();
    const prev = stack[stack.length - 1] || 'four_button';
    this.navStacks.set(tid, stack);
    return prev;
  }

  currentNav(telegramId) {
    const tid = String(telegramId);
    const stack = this.navStacks.get(tid) || ['four_button'];
    return stack[stack.length - 1] || 'four_button';
  }

  resetNav(telegramId, screen = 'four_button') {
    this.navStacks.set(String(telegramId), [screen]);
  }
}

export const stateManager = new StateManager();

type Key = string; // conversationId

class StreamRegistry {
  private controllers: Map<Key, AbortController> = new Map();

  set(conversationId: Key, controller: AbortController) {
    this.controllers.set(conversationId, controller);
  }

  get(conversationId: Key): AbortController | undefined {
    return this.controllers.get(conversationId);
  }

  stop(conversationId: Key) {
    const c = this.controllers.get(conversationId);
    if (c) {
      c.abort();
      this.controllers.delete(conversationId);
    }
  }

  clear(conversationId: Key) {
    this.controllers.delete(conversationId);
  }
}

export const streamRegistry = new StreamRegistry();



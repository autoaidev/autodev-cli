import { appendTask, resetToTodo, resetAllInProgress, markDone, Task } from './todo';

/**
 * Serialises all mutating TODO.md operations so concurrent callers
 * (email poller, webhook poller, discord poller, sidebar "Add task", task loop)
 * never overwrite each other's changes.
 *
 * Each write operation is queued per file path and executes only after all
 * previously enqueued operations for that path have settled (resolved or
 * rejected).  The queue is purely in-process — it does not use file locks,
 * which is sufficient because all writes originate from within this extension.
 */
class TodoWriteManager {
    private readonly _tails = new Map<string, Promise<unknown>>();

    private _enqueue<T>(filePath: string, op: () => T): Promise<T> {
        const tail = this._tails.get(filePath) ?? Promise.resolve();
        // Use two-arg .then so the queue keeps draining even if a prior op threw.
        const result: Promise<T> = (tail as Promise<void>).then(() => op(), () => op());
        // Store a never-rejecting tail so subsequent ops always get a chance to run.
        this._tails.set(filePath, result.then(() => undefined, () => undefined));
        return result;
    }

    /** Append a new task to the Todo section and return its generated task ID. */
    append(filePath: string, text: string, id?: string): Promise<string> {
        return this._enqueue(filePath, () => appendTask(filePath, text, id));
    }

    /** Reset a single [~] in-progress task back to [ ]. */
    resetToTodo(filePath: string, task: Task): Promise<void> {
        return this._enqueue(filePath, () => resetToTodo(filePath, task));
    }

    /** Reset ALL [~] in-progress tasks back to [ ]. */
    resetAllInProgress(filePath: string): Promise<void> {
        return this._enqueue(filePath, () => resetAllInProgress(filePath));
    }

    /** Mark a task as [x] done in TODO.md. */
    markDone(filePath: string, task: Task): Promise<void> {
        return this._enqueue(filePath, () => markDone(filePath, task));
    }
}

/** Singleton — import this everywhere instead of calling todo.ts write functions directly. */
export const todoWriter = new TodoWriteManager();

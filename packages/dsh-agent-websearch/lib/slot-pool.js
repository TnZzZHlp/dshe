import { abortError } from './errors.js'

/**
 * Small FIFO pool that hands out bounded concurrency slots and honors abort
 * signals while waiting for one.
 */
export class SlotPool {
  constructor(size) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('SlotPool size must be a positive integer')
    this.free = Array.from({ length: size }, (_, index) => index)
    this.waiters = []
  }

  acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal !== undefined && signal.aborted) {
        reject(abortError())
        return
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(grant)
        if (index >= 0) this.waiters.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
        reject(abortError())
      }
      const grant = slot => {
        signal?.removeEventListener('abort', onAbort)
        resolve(slot)
      }
      if (this.free.length > 0) {
        const slot = this.free.pop()
        grant(slot)
        return
      }
      this.waiters.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  release(slot) {
    const next = this.waiters.shift()
    if (next !== undefined) next(slot)
    else this.free.push(slot)
  }
}

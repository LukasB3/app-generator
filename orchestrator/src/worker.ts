import { EventEmitter } from 'node:events'
import { publicError, type Pipeline } from './pipeline.js'
import type { EventType, JobEvent, JobStatus, Store } from './store.js'

// Runs exactly one job at a time, oldest first, and fans progress out to
// whoever is watching. `job:<id>` carries events, `queue` signals movement.
export class Worker extends EventEmitter {
  private busy = false

  constructor(
    private store: Store,
    private pipeline: Pipeline,
    private log: (message: string, error?: unknown) => void = console.error,
  ) {
    super()
    this.setMaxListeners(0)
  }

  kick() {
    if (this.busy) return
    const job = this.store.nextQueued()
    if (!job) return
    this.busy = true

    const publish = (event: JobEvent) => this.emit(`job:${job.id}`, event)
    const add = (type: EventType) => (data: string) => publish(this.store.addEvent(job.id, type, data))
    const status = (value: JobStatus, result?: { url?: string; error?: string }) => {
      publish(this.store.setStatus(job.id, value, result))
      this.emit('queue')
    }

    this.pipeline(job, { status, file: add('file'), note: add('note'), cost: (microUsd) => this.store.setCost(job.id, microUsd) })
      .then((url) => status('done', { url }))
      .catch((error: unknown) => {
        this.log(`job ${job.id} failed`, error)
        status('failed', { error: publicError(error) })
      })
      .finally(() => {
        this.busy = false
        this.kick()
      })
  }
}

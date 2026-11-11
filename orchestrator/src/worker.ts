import { EventEmitter } from 'node:events'
import { publicError, type Pipeline } from './pipeline.js'
import type { EventType, Job, JobEvent, JobStatus, Store } from './store.js'

// Runs up to `atOnce` jobs side by side, oldest first, and fans progress out
// to whoever is watching. `job:<id>` carries events, `queue` signals movement.
export class Worker extends EventEmitter {
  private running = new Set<string>()

  constructor(
    private store: Store,
    private pipeline: Pipeline,
    private atOnce: number,
    private log: (message: string, error?: unknown) => void = console.error,
  ) {
    super()
    this.setMaxListeners(0)
  }

  kick() {
    while (this.running.size < this.atOnce) {
      // A job counts as queued until its pipeline reports a step, so the ones taken here are passed over.
      const job = this.store.nextQueued(this.running)
      if (!job) return
      this.run(job)
    }
  }

  private run(job: Job) {
    this.running.add(job.id)

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
        this.running.delete(job.id)
        this.kick()
      })
  }
}

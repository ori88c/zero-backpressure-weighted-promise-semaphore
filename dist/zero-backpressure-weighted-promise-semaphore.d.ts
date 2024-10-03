/**
 * Copyright 2024 Ori Cohen https://github.com/ori88c
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
export type SemaphoreJob<T> = () => Promise<T>;
/**
 * ZeroBackpressureWeightedSemaphore
 *
 * The `ZeroBackpressureWeightedSemaphore` class implements a Promise Semaphore for Node.js projects,
 * enabling users to limit the concurrency of *weighted* jobs.
 * Each job is associated with a natural-number weight (1, 2, 3, ...). The semaphore guarantees that the
 * total weight of concurrently executing jobs never exceeds a user-defined limit.
 * The use of natural numbers for weights is mandated to prevent floating-point precision issues inherent
 * in JavaScript.
 *
 * The weighted jobs functionality is ideal for scenarios where jobs have varying processing requirements,
 * and the backend application needs to manage load on a particular resource. For example, dispatching
 * ML jobs of differing complexities to the same EC2 machine. Although the Node.js application itself
 * does not perform the CPU-intensive ML calculations, users can still benefit from load-limiting on
 * the EC2 machine.
 *
 * This implementation does not queue pending jobs, thereby eliminating backpressure. As a result, users
 * have better control over memory footprint, which enhances performance by reducing garbage-collector
 * overhead.
 *
 * The design addresses the two primary semaphore use cases in Node.js:
 * 1. **Single Job Execution**: A sub-procedure for which the caller must wait before proceeding with
 *    its work. In this case, the job's completion time is crucial to know.
 * 2. **Multiple Jobs Execution**: In this case, the start time of a given job is crucial. Since a
 *    pending job cannot start its execution until the semaphore allows, there is no reason to add
 *    additional jobs that cannot start either.
 *    Once all the jobs are completed, some post-processing logic may be required. The API provides a
 *    designated method to wait until there are no currently-executing jobs.
 *
 * ### Modern API Design
 * Traditional semaphore APIs require explicit acquire and release steps, adding overhead and
 * responsibility on the user.
 * In contrast, `ZeroBackpressureWeightedPromiseSemaphore` manages job execution, abstracting away these
 * details and reducing user responsibility. The acquire and release steps are handled implicitly by the
 * execution methods, reminiscent of the RAII idiom in C++.
 * Method names are chosen to clearly convey their functionality.
 *
 * ### Graceful Termination
 * All the job execution promises are tracked by the semaphore instance, ensuring no dangling promises.
 * This enables graceful termination via the `waitForAllExecutingJobsToComplete` method, which is
 * particularly useful for the multiple jobs execution use-case. This can help perform necessary
 * post-processing logic, and ensure a clear state between unit-tests.
 * If your component has a termination method (`stop`, `terminate`, or similar), keep that in mind.
 *
 * ### Error Handling for Background Jobs
 * Background jobs triggered by `startExecution` may throw errors. Unlike the `waitForCompletion` case,
 * the caller has no reference to the corresponding job promise which executes in the background.
 * Therefore, errors from background jobs are captured by the semaphore and can be extracted using
 * the `extractUncaughtErrors` method. The number of accumulated uncaught errors can be obtained via
 * the `amountOfUncaughtErrors` getter method. This can be useful, for example, if the user wants to
 * handle uncaught errors only after a certain threshold is reached.
 *
 * ### Complexity
 * - **Initialization**: O(estimatedMaxNumberOfConcurrentJobs) for both time and space.
 * - **startExecution, waitForCompletion**: O(1) for both time and space, excluding the job execution itself.
 * - All the getter methods have O(1) complexity for both time and space.
 *
 */
export declare class ZeroBackpressureWeightedSemaphore<T = void, UncaughtErrorType = Error> {
    private readonly _totalAllowedWeight;
    private readonly _availableSlotsStack;
    private readonly _slots;
    private _availableWeight;
    private _amountOfCurrentlyExecutingJobs;
    private _uncaughtErrors;
    private _pendingWeightAllotment;
    private _waitForSufficientWeight?;
    private _notifyPendingAllotment?;
    /**
     * Constructor
     *
     * @param totalAllowedWeight - The maximum allowed sum of weights (inclusive) for jobs executed concurrently.
     * @param estimatedMaxNumberOfConcurrentJobs - Estimated maximum number of concurrently executing jobs.
     *                                             A higher estimate reduces the likelihood of additional slot
     *                                             allocations during runtime. Please observe that the upper bound
     *                                             is `totalAllowedWeight`, as the minimum weight is 1.
     */
    constructor(totalAllowedWeight: number, estimatedMaxNumberOfConcurrentJobs?: number);
    /**
     * totalAllowedWeight
     *
     * @returns The maximum allowed sum of weights (inclusive) for jobs executed concurrently.
     */
    get totalAllowedWeight(): number;
    /**
     * availableWeight
     *
     * @returns The currently available, non-allotted amount of weight.
     */
    get availableWeight(): number;
    /**
     * amountOfCurrentlyExecutingJobs
     *
     * @returns The number of jobs currently being executed by the semaphore.
     */
    get amountOfCurrentlyExecutingJobs(): number;
    /**
     * amountOfUncaughtErrors
     *
     * Indicates the number of uncaught errors from background jobs triggered by `startExecution`,
     * that are currently stored by the instance.
     * These errors have not yet been extracted using `extractUncaughtErrors`.
     *
     * @returns The number of uncaught errors from background jobs.
     */
    get amountOfUncaughtErrors(): number;
    /**
     * startExecution
     *
     * This method resolves once the given job has *started* its execution, indicating that the
     * semaphore has allotted sufficient weight for the job.
     * Users can leverage this to prevent backpressure of pending jobs:
     * If the semaphore is too busy to start a given job `X`, there is no reason to create another
     * job `Y` until `X` has started.
     *
     * This method is particularly useful for executing multiple or background jobs, where no return
     * value is expected. It promotes a just-in-time approach, on which each job is pending execution
     * only when no other job is, thereby eliminating backpressure and reducing memory footprint.
     *
     * ### Graceful Termination
     * Method `waitForAllExecutingJobsToComplete` complements the typical use-cases of `startExecution`.
     * It can be used to perform post-processing, after all the currently-executing jobs have completed.
     *
     * ### Error Handling
     * If the job throws an error, it is captured by the semaphore and can be accessed via the
     * `extractUncaughtError` method. Users are encouraged to specify a custom `UncaughtErrorType`
     * generic parameter to the class if jobs may throw errors.
     *
     * @param backgroundJob - The job to be executed once the semaphore is available.
     * @param weight - A natural number representing the weight associated with the job.
     * @throws - Error if the weight is not a natural number (1, 2, 3, ...).
     * @returns A promise that resolves when the job starts execution.
     */
    startExecution(backgroundJob: SemaphoreJob<T>, weight: number): Promise<void>;
    /**
     * waitForCompletion
     *
     * This method executes the given job in a controlled manner, once the semaphore has allotted
     * sufficient weight for the job. It resolves or rejects when the job finishes execution, returning
     * the job's value or propagating any error it may throw.
     *
     * This method is useful when the flow depends on a job's execution to proceed, such as needing
     * its return value or handling any errors it may throw.
     *
     * ### Example Use Case
     * Suppose you have a route handler that needs to perform a specific code block with limited
     * concurrency (e.g., database access) due to external constraints, such as throttling limits.
     * This method allows you to execute the job with controlled concurrency. Once the job resolves
     * or rejects, you can continue the route handler's flow based on the result.
     *
     * @param job - The job to be executed once the semaphore is available.
     * @param weight - A natural number representing the weight associated with the job.
     * @throws - Error if the weight is not a natural number (1, 2, 3, ...).
     *           Alternatively, an error thrown by the job itself.
     * @returns A promise that resolves with the job's return value or rejects with its error.
     */
    waitForCompletion(job: SemaphoreJob<T>, weight: number): Promise<T>;
    /**
     * waitForAllExecutingJobsToComplete
     *
     * This method allows the caller to wait until all *currently* executing jobs have finished,
     * meaning once all running promises have either resolved or rejected.
     *
     * This is particularly useful in scenarios where you need to ensure that all jobs are completed
     * before proceeding, such as during shutdown processes or between unit tests.
     *
     * Note that the returned promise only awaits jobs that were executed at the time this method
     * was called. Specifically, it awaits all jobs initiated by this instance that had not completed
     * at the time of invocation.
     *
     * @returns A promise that resolves when all currently executing tasks are completed.
     */
    waitForAllExecutingJobsToComplete(): Promise<void>;
    /**
     * extractUncaughtErrors
     *
     * This method returns an array of uncaught errors, captured by the semaphore while executing
     * background jobs added by `startExecution`. The term `extract` implies that the semaphore
     * instance will no longer hold these error references once extracted, unlike `get`. In other
     * words, ownership of these uncaught errors shifts to the caller, while the semaphore clears
     * its list of uncaught errors.
     *
     * Even if the user does not intend to perform error-handling with these uncaught errors, it is
     * important to periodically call this method when using `startExecution` to prevent the
     * accumulation of errors in memory.
     * However, there are a few exceptional cases where the user can safely avoid extracting
     * uncaught errors:
     * - The number of jobs is relatively small and the process is short-lived.
     * - The jobs never throw errors, thus no uncaught errors are possible.
     *
     * @returns An array of uncaught errors from background jobs triggered by `startExecution`.
     */
    extractUncaughtErrors(): UncaughtErrorType[];
    private _validateWeight;
    private _allotWeight;
    private _getAvailableSlot;
    /**
     * _handleJobExecution
     *
     * This method manages the execution of a given job in a controlled manner. It ensures that
     * the job is executed within the constraints of the semaphore and handles updating the
     * internal state once the job has completed.
     *
     * ### Behavior
     * - Waits for the job to either return a value or throw an error.
     * - Updates the internal state to make the allotted slot available again once the job is finished.
     * - Release the weight-allotment lock if the requested amount is available.
     *
     * @param job - The job to be executed in the given slot.
     * @param allottedSlot - The slot number in which the job should be executed.
     * @param weight - A natural number representing the weight associated with the job.
     * @param isBackgroundJob - A flag indicating whether the caller expects a return value to proceed
     *                          with its work. If `true`, no return value is expected, and any error
     *                          thrown by the job should not be propagated to the event loop.
     * @returns A promise that resolves with the job's return value or rejects with its error.
     *          Rejection occurs only if triggered by `waitForCompletion`.
     */
    _handleJobExecution(job: SemaphoreJob<T>, allottedSlot: number, weight: number, isBackgroundJob: boolean): Promise<T>;
}

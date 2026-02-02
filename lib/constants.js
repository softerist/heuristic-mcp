/**
 * Centralized constants for the heuristic-mcp project.
 * Extracting magic numbers improves maintainability and documents design decisions.
 */

// ================================
// Chunking Constants
// ================================

/**
 * Minimum text length for a chunk to be considered valid.
 * Prevents tiny fragments from polluting search results.
 * Chunks shorter than this are discarded.
 */
export const MIN_CHUNK_TEXT_LENGTH = 20;

/**
 * Absolute limit on overlap calculation iterations.
 * Prevents unbounded loops when processing files with many zero-token lines.
 */
export const MAX_OVERLAP_ITERATIONS = 50;

/**
 * Target token ratio relative to max tokens.
 * Chunks aim to be 85% of max capacity to leave room for context.
 */
export const TARGET_TOKEN_RATIO = 0.85;

/**
 * Overlap token ratio relative to target tokens.
 * 18% overlap provides good context continuity between chunks.
 */
export const OVERLAP_TOKEN_RATIO = 0.18;

// ================================
// Cache Constants
// ================================

/**
 * Maximum entries in the chunking params LRU cache.
 * Trade-off: memory vs. lookup time. 100 is sufficient for typical workloads.
 */
export const CHUNKING_PARAMS_CACHE_SIZE = 100;

/**
 * JSON files larger than this threshold are parsed in a worker thread.
 * Prevents main thread blocking on large cache files.
 */
export const JSON_WORKER_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2MB

// ================================
// Worker Constants
// ================================

/**
 * Number of results to batch before sending to main thread.
 * Balances IPC overhead vs. memory usage in worker communication.
 */
export const RESULT_BATCH_SIZE = 25;

/**
 * Default batch size for embedding inference.
 * Balances memory usage with throughput for ONNX runtime.
 */
export const DEFAULT_INFERENCE_BATCH_SIZE = 4;

/**
 * Timeout for worker batch processing before considering it failed.
 * Generous timeout to handle large files with complex embeddings.
 */
export const WORKER_BATCH_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Cooldown period after worker failures before retrying worker use.
 */
export const WORKER_FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Delay before starting background indexing after server connects.
 * Allows server to accept first request before CPU-intensive work.
 */
export const BACKGROUND_INDEX_DELAY_MS = 3000;

/**
 * Concurrency limit for file stat operations during search.
 * Prevents EMFILE (too many open files) errors.
 */
export const FILE_STAT_CONCURRENCY_LIMIT = 50;

/**
 * Maximum entries in file modification time LRU cache.
 */
export const LRU_MAX_ENTRIES = 5000;

/**
 * Target entries after LRU eviction (80% of max).
 */
export const LRU_TARGET_ENTRIES = 4000;

/**
 * Interval for logging memory usage during indexing.
 * Helps diagnose memory leaks and OOM issues.
 */
export const MEMORY_LOG_INTERVAL_MS = 15_000; // 15 seconds

/**
 * Retry delay when SQLite file is locked or busy.
 */
export const SQLITE_FILE_RETRY_DELAY_MS = 50;

/**
 * Number of retries when SQLite file is locked or busy.
 * Combined with delay: max wait = 50ms * 40 = 2 seconds.
 */
export const SQLITE_FILE_RETRY_COUNT = 40;

// ================================
// Search Constants
// ================================

/**
 * Batch size for scoring chunks during search.
 * Yields to event loop between batches to maintain responsiveness.
 */
export const SEARCH_SCORING_BATCH_SIZE = 500;

/**
 * Maximum number of files for recency boost IO operations.
 * Above this, we rely on cached metadata only to prevent IO storms.
 */
export const RECENCY_BOOST_MAX_IO_FILES = 1000;

/**
 * Maximum size for full linear scan fallback.
 * Above this, we skip full scan to prevent performance degradation.
 */
export const MAX_FULL_SCAN_SIZE = 50_000;

// ================================
// ANN (Approximate Nearest Neighbor) Constants
// ================================

/**
 * Number of vectors to sample for dimension consistency validation.
 */
export const ANN_DIMENSION_SAMPLE_SIZE = 100;

/**
 * Minimum chunks required before enabling ANN index.
 * Linear scan is faster for smaller datasets.
 */
export const ANN_MIN_CHUNKS_DEFAULT = 5000;

/**
 * Cooldown period after hnswlib load errors before retrying.
 * Prevents tight error loops when the native module fails to load.
 */
export const HNSWLIB_ERROR_RESET_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Default timeout for waiting on active readers before aborting save.
 * Balances data safety with responsiveness.
 */
export const DEFAULT_READER_WAIT_TIMEOUT_MS = 5000;

// ================================
// Vector Store Format Constants
// ================================

/**
 * Binary vector store format version.
 * Increment when binary format changes to trigger re-indexing.
 */
export const BINARY_STORE_VERSION = 1;

/**
 * SQLite vector store format version.
 * Increment when schema changes to trigger re-indexing.
 */
export const SQLITE_STORE_VERSION = 1;

/**
 * Binary vector file header size in bytes.
 * Contains: magic (4) + version (4) + dim (4) + count (4) + reserved (4)
 */
export const BINARY_VECTOR_HEADER_SIZE = 20;

/**
 * Binary record file header size in bytes.
 * Contains: magic (4) + version (4) + count (4) + reserved (8)
 */
export const BINARY_RECORD_HEADER_SIZE = 20;

/**
 * Binary content file header size in bytes.
 * Contains: magic (4) + version (4) + count (4) + reserved (8)
 */
export const BINARY_CONTENT_HEADER_SIZE = 20;

/**
 * Size of a single record entry in bytes.
 * Contains: file offset (4) + file length (4) + startLine (4) + endLine (4) +
 *           content offset (4) + content length (4) + reserved (8)
 */
export const BINARY_RECORD_SIZE = 32;

// ================================
// Watcher Constants
// ================================

/**
 * Maximum pending watch events before dropping oldest.
 * Prevents memory exhaustion during rapid file churn (e.g., build processes).
 */
export const MAX_PENDING_WATCH_EVENTS = 10000;

/**
 * Target size after trimming pending watch events (50% of max).
 * Provides hysteresis to avoid repeated trim operations.
 */
export const PENDING_WATCH_EVENTS_TRIM_SIZE = 5000;

// ================================
// ONNX Constants
// ================================

/**
 * Thread limit for ONNX runtime when native backend is unavailable.
 * Reduces CPU contention on the main thread.
 */
export const ONNX_THREAD_LIMIT = 2;

/**
 * Partial match boost factor for keyword matching in search.
 * Applied when query words are found but not exact phrase match.
 */
export const PARTIAL_MATCH_BOOST = 0.3;

/**
 * Text match candidate limit for deferred text matching.
 * Limits expensive string operations to top candidates.
 */
export const TEXT_MATCH_MAX_CANDIDATES = 2000;

/**
 * Concurrency limit for file stat operations in search.
 * Prevents EMFILE errors from too many simultaneous file handles.
 */
export const STAT_CONCURRENCY_LIMIT = 50;

/**
 * Batch size for scoring chunks in hybrid search.
 * Allows event loop to tick between batches for responsiveness.
 */
export const SEARCH_BATCH_SIZE = 500;


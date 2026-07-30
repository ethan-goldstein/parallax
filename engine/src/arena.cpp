#include "px/arena.hpp"

#include <cstdlib>
#include <utility>

namespace px {

namespace {

// Rounds `n` up to the next multiple of `align`, which must be a power of two.
constexpr usize align_up(usize n, usize align) noexcept {
  return (n + align - 1) & ~(align - 1);
}

// [[maybe_unused]]: only referenced from PX_ASSERT, which compiles out under
// NDEBUG, so the release build would otherwise warn on an unused function.
[[maybe_unused]] constexpr bool is_power_of_two(usize n) noexcept {
  return n != 0 && (n & (n - 1)) == 0;
}

}  // namespace

Arena::Arena(usize capacity_bytes) {
  if (capacity_bytes == 0) return;

  // std::malloc rather than ::operator new: with -fno-exceptions, operator new
  // aborts on failure instead of returning, and the arena wants to report
  // exhaustion as a value so callers can degrade (truncate a result set)
  // rather than take the process down.
  base_ = static_cast<u8*>(std::malloc(capacity_bytes));
  cap_ = base_ ? capacity_bytes : 0;
}

Arena::~Arena() {
  std::free(base_);
}

Arena::Arena(Arena&& other) noexcept
    : base_(other.base_), cap_(other.cap_), head_(other.head_), peak_(other.peak_) {
  other.base_ = nullptr;
  other.cap_ = 0;
  other.head_ = 0;
  other.peak_ = 0;
}

Arena& Arena::operator=(Arena&& other) noexcept {
  if (this != &other) {
    std::free(base_);
    base_ = std::exchange(other.base_, nullptr);
    cap_ = std::exchange(other.cap_, 0);
    head_ = std::exchange(other.head_, 0);
    peak_ = std::exchange(other.peak_, 0);
  }
  return *this;
}

void* Arena::alloc(usize bytes, usize align) noexcept {
  PX_ASSERT(is_power_of_two(align), "alignment must be a power of two");
  if (bytes == 0 || base_ == nullptr) return nullptr;

  const usize start = align_up(head_, align);

  // Checked in this order on purpose: `start + bytes` can wrap if bytes is
  // enormous, and a wrapped sum would compare as fitting.
  if (start > cap_ || bytes > cap_ - start) return nullptr;

  head_ = start + bytes;
  if (head_ > peak_) peak_ = head_;
  return base_ + start;
}

void Arena::release(usize mark) noexcept {
  PX_ASSERT(mark <= head_, "arena release must rewind, never advance");
  if (mark <= head_) head_ = mark;
}

}  // namespace px

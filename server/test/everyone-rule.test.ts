import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasEveryoneMention } from '../../shared/protocol.ts'

test('@everyone pings only as a word of its own', () => {
  for (const s of ['@everyone', 'hey @everyone!', '@everyone.', '(@everyone)', 'game night @everyone, 9pm', '"@everyone"', 'line\n@everyone']) {
    assert.equal(hasEveryoneMention(s), true, s)
  }
  for (const s of ['bob@everyone.org', 'https://x.com/@everyone', '@everyones', 'x.com/?a=@everyone', '@everyone-team', 'everyone', 'mail@everyone']) {
    assert.equal(hasEveryoneMention(s), false, s)
  }
})

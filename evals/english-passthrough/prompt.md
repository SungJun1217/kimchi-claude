---
max_turns: 1
allowed_tools: []
tags: [non-interference]
---
Explain why this function is slow and how to fix it.

```js
function findUsers(ids, allUsers) {
  const result = [];
  for (const id of ids) {
    result.push(allUsers.find((user) => user.id === id));
  }
  return result;
}
```

<!-- kimchi-ignore-file -->
---
max_turns: 1
allowed_tools: []
tags: [tone]
---
아래 함수가 왜 느린지, 어떻게 고치면 되는지 한국어로 설명해줘.

```js
function findUsers(ids, allUsers) {
  const result = [];
  for (const id of ids) {
    result.push(allUsers.find((user) => user.id === id));
  }
  return result;
}
```

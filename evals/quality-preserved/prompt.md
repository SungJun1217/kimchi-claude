<!-- kimchi-ignore-file -->
---
max_turns: 1
allowed_tools: []
tags: [quality]
---
이 함수가 항상 0을 돌려준다는 제보를 받았어. 원인이 뭐고 어떻게 고쳐야 하는지 한국어로 설명해줘.

```js
async function totalScores(userIds, fetchScore) {
  let total = 0;
  userIds.forEach(async (id) => {
    total += await fetchScore(id);
  });
  return total;
}
```

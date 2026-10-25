import os
import requests
import time
import json
from PIL import Image
from io import BytesIO

base_url = 'https://api-inference.modelscope.cn/'
api_key = os.environ.get('MODELSCOPE_API_KEY', '')
if not api_key:
    raise SystemExit('请先设置环境变量 MODELSCOPE_API_KEY')

common_headers = {
    "Authorization": f"Bearer {api_key}",
    "Content-Type": "application/json",
}

ROUNDS = 3
results = []

for round_num in range(1, ROUNDS + 1):
    print(f"\n{'='*50}")
    print(f"Round {round_num}/{ROUNDS}")
    print(f"{'='*50}")
    
    start_time = time.time()
    
    response = requests.post(
        f"{base_url}v1/images/generations",
        headers={**common_headers, "X-ModelScope-Async-Mode": "true"},
        data=json.dumps({
            "model": "FireRedTeam/FireRed-Image-Edit-1.1",
            "prompt": "turn the girl's hair blue",
            "image_url": "https://resources.modelscope.cn/aigc/image_edit.png"
        }, ensure_ascii=False).encode('utf-8')
    )
    
    response.raise_for_status()
    task_id = response.json()["task_id"]
    print(f"[{time.time()-start_time:.2f}s] Task submitted: {task_id}")
    
    poll_count = 0
    success = False
    while poll_count < 60:
        poll_count += 1
        result = requests.get(
            f"{base_url}v1/tasks/{task_id}",
            headers={**common_headers, "X-ModelScope-Task-Type": "image_generation"},
        )
        data = result.json()
        status = data.get("task_status", "UNKNOWN")
        
        if status == "SUCCEED":
            img_resp = requests.get(data["output_images"][0])
            image = Image.open(BytesIO(img_resp.content))
            image.save(f"result_round{round_num}.jpg")
            success = True
            break
        elif status == "FAILED":
            print(f"  FAILED: {json.dumps(data, ensure_ascii=False)[:300]}")
            break
        
        time.sleep(5)
    
    total_time = time.time() - start_time
    results.append({
        "round": round_num,
        "time": total_time,
        "success": success,
        "polls": poll_count
    })
    print(f"Round {round_num}: {total_time:.2f}s ({'OK' if success else 'FAIL'})")

print(f"\n{'='*50}")
print(f"SUMMARY")
print(f"{'='*50}")
for r in results:
    print(f"  Round {r['round']}: {r['time']:.2f}s - {'SUCCESS' if r['success'] else 'FAILED'}")

times = [r['time'] for r in results if r['success']]
if times:
    print(f"\n  Min: {min(times):.2f}s")
    print(f"  Max: {max(times):.2f}s")
    print(f"  Avg: {sum(times)/len(times):.2f}s")
    print(f"  Success rate: {len(times)}/{len(results)}")

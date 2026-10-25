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

start_time = time.time()
print(f"[{time.time()-start_time:.2f}s] Submitting task...")

response = requests.post(
    f"{base_url}v1/images/generations",
    headers={**common_headers, "X-ModelScope-Async-Mode": "true"},
    data=json.dumps({
        "model": "FireRedTeam/FireRed-Image-Edit-1.1",
        "prompt": "turn the girl's hair blue",
        "image_url": "https://resources.modelscope.cn/aigc/image_edit.png"
    }, ensure_ascii=False).encode('utf-8')
)

print(f"[{time.time()-start_time:.2f}s] Status: {response.status_code}")
print(f"[{time.time()-start_time:.2f}s] Response: {response.text[:500]}")
response.raise_for_status()
task_id = response.json()["task_id"]
print(f"[{time.time()-start_time:.2f}s] Task ID: {task_id}")
submit_time = time.time() - start_time
print(f"Submit time: {submit_time:.2f}s")

poll_count = 0
max_polls = 60  # max 5 minutes polling
while poll_count < max_polls:
    poll_count += 1
    elapsed = time.time() - start_time
    result = requests.get(
        f"{base_url}v1/tasks/{task_id}",
        headers={**common_headers, "X-ModelScope-Task-Type": "image_generation"},
    )
    data = result.json()
    status = data.get("task_status", "UNKNOWN")
    print(f"[{elapsed:.2f}s] Poll #{poll_count} - Status: {status}")

    if status == "SUCCEED":
        print(f"[{time.time()-start_time:.2f}s] Downloading image...")
        img_resp = requests.get(data["output_images"][0])
        image = Image.open(BytesIO(img_resp.content))
        image.save("result_image.jpg")
        print(f"[{time.time()-start_time:.2f}s] Image saved as result_image.jpg")
        break
    elif status == "FAILED":
        print(f"Image Generation Failed. Response: {json.dumps(data, ensure_ascii=False)[:500]}")
        break

    time.sleep(5)

total_time = time.time() - start_time
print(f"\n=== RESULT ===")
print(f"Poll count: {poll_count}")
print(f"Total time: {total_time:.2f}s")

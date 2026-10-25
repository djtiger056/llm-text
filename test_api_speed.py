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
    'Authorization': f'Bearer {api_key}',
    'Content-Type': 'application/json',
}

start_total = time.time()

# Submit request
print('Submitting request...')
start_submit = time.time()
response = requests.post(
    f'{base_url}v1/images/generations',
    headers={**common_headers, 'X-ModelScope-Async-Mode': 'true'},
    data=json.dumps({
        'model': 'Tongyi-MAI/Z-Image-Turbo',
        'prompt': 'A golden cat'
    }, ensure_ascii=False).encode('utf-8')
)
submit_time = time.time() - start_submit
print(f'Submit took: {submit_time:.2f}s')

response.raise_for_status()
task_id = response.json()['task_id']
print(f'Task ID: {task_id}')

# Poll for completion
poll_count = 0
while True:
    poll_start = time.time()
    result = requests.get(
        f'{base_url}v1/tasks/{task_id}',
        headers={**common_headers, 'X-ModelScope-Task-Type': 'image_generation'},
    )
    poll_time = time.time() - poll_start
    poll_count += 1
    result.raise_for_status()
    data = result.json()

    if data['task_status'] == 'SUCCEED':
        print(f'Poll #{poll_count} took: {poll_time:.2f}s')
        print(f'Task succeeded!')
        
        # Download image
        start_download = time.time()
        image = Image.open(BytesIO(requests.get(data['output_images'][0]).content))
        download_time = time.time() - start_download
        image.save('result_image.jpg')
        print(f'Image download + save: {download_time:.2f}s')
        break
    elif data['task_status'] == 'FAILED':
        print('Image Generation Failed.')
        break
    
    print(f'Poll #{poll_count}: status={data["task_status"]}, poll took {poll_time:.2f}s')
    time.sleep(5)

total_time = time.time() - start_total
print(f'\n=== SUMMARY ===')
print(f'Total time: {total_time:.2f}s')
print(f'Submit time: {submit_time:.2f}s')
print(f'Polling rounds: {poll_count}')
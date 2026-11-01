"""Strict completion/metric checks, independent of retriever implementation."""
import collections
import re
import string

def completion_text(status, payload):
    if status != 200 or 'error' in payload or len(payload.get('choices', [])) != 1:
        raise ValueError('invalid provider response')
    choice = payload['choices'][0]
    text = choice.get('message', {}).get('content')
    if choice.get('finish_reason') != 'stop' or not isinstance(text, str) or not text.strip():
        raise ValueError('empty, truncated or unfinished completion')
    return text.strip()

def judge_verdict(text):
    match = re.fullmatch(r'\s*(yes|no)[.!]?\s*', text, re.IGNORECASE)
    if not match:
        raise ValueError('ambiguous judge verdict')
    return match[1].lower() == 'yes'

def normalize(text):
    text = str(text).lower().translate(str.maketrans('', '', string.punctuation))
    return ' '.join(re.sub(r'\b(a|an|the)\b', ' ', text).split())

def answer_metrics(answer, references):
    prediction = normalize(answer)
    scores = []
    for reference in references:
        gold = normalize(reference)
        exact = float(prediction == gold)
        p, g = prediction.split(), gold.split()
        overlap = sum((collections.Counter(p) & collections.Counter(g)).values())
        f1 = 2 * overlap / (len(p) + len(g)) if p or g else 1.0
        scores.append((exact, f1))
    return {'exactMatch': max((s[0] for s in scores), default=0), 'tokenF1': max((s[1] for s in scores), default=0)}

def source_metrics(actual, expected):
    if not expected:
        return None
    found = len(set(actual) & set(expected))
    return {'recallAt3': found / len(set(expected)), 'complete': set(expected) <= set(actual)}

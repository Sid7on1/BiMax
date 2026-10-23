import importlib.util
import ast
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('grader', Path(__file__).parent / 'lib/rag_public_grader.py')
grader = importlib.util.module_from_spec(spec); spec.loader.exec_module(grader)

class GraderTests(unittest.TestCase):
    def test_control_reuse_retains_wrong_verdicts_and_requires_exact_requests(self):
        source = Path(__file__).parent / 'bench-rag-public.py'
        function = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'matching_control')
        namespace = {'grader': grader}; exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        body = {'model': 'same-model', 'messages': ['fixed control']}
        previous = {'valid': True, 'status': 200, 'request': body,
            'response': {'choices': [{'finish_reason': 'stop', 'message': {'content': 'no'}}]}}
        self.assertEqual(namespace['matching_control'](previous, body), 'no')
        self.assertIsNone(namespace['matching_control']({**previous, 'valid': False}, body))
        with self.assertRaises(AssertionError): namespace['matching_control'](previous, {**body, 'model': 'different-model'})
        with self.assertRaises(ValueError): namespace['matching_control']({**previous, 'status': 500}, body)
    def test_ingestion_preserves_repeated_sessions_without_indexing_labels(self):
        source = Path(__file__).parent / 'bench-rag-public.py'
        function = next(node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef) and node.name == 'documents_lme')
        namespace = {}; exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        row = {'haystack_session_ids': ['same', 'same'], 'haystack_dates': ['2024/01/01', '2024/02/01'],
            'haystack_sessions': [[{'role': 'user', 'content': 'Old value', 'has_answer': True}], [{'role': 'user', 'content': 'New value', 'has_answer': False}]],
            'answer': 'Secret gold label', 'answer_session_ids': ['same']}
        docs = namespace['documents_lme'](row)
        self.assertEqual([doc['id'] for doc in docs], ['same', 'same::bimax-occurrence:1'])
        self.assertEqual(docs[1]['sourceSessionId'], 'same')
        self.assertIn('Old value', docs[0]['text']); self.assertIn('New value', docs[1]['text'])
        self.assertNotIn('Secret gold label', str(docs)); self.assertNotIn('has_answer', str(docs))
        with self.assertRaises(AssertionError): namespace['documents_lme']({**row, 'haystack_dates': []})
    def test_exact_and_paraphrase_metrics_are_separate(self):
        self.assertEqual(grader.answer_metrics('The red boat.', ['red boat']), {'exactMatch': 1, 'tokenF1': 1})
        self.assertEqual(grader.answer_metrics('not a red boat', ['red boat'])['exactMatch'], 0)
    def test_missing_sources_and_duplicates_cannot_pass(self):
        self.assertEqual(grader.source_metrics(['a', 'a'], ['a', 'b']), {'recallAt3': .5, 'complete': False})
        self.assertIsNone(grader.source_metrics([], []))
    def test_provider_errors_empty_truncation_and_foreign_structure_refuse(self):
        good = {'choices': [{'finish_reason': 'stop', 'message': {'content': 'yes'}}]}
        self.assertEqual(grader.completion_text(200, good), 'yes')
        for status, payload in [(500, good), (200, {**good, 'error': {}}), (200, {}),
            (200, {'choices': [{'finish_reason': 'length', 'message': {'content': 'yes'}}]}),
            (200, {'choices': [{'finish_reason': 'stop', 'message': {'content': ''}}]})]:
            with self.subTest(status=status, payload=payload):
                with self.assertRaises(ValueError): grader.completion_text(status, payload)
    def test_only_unambiguous_final_verdicts_count(self):
        self.assertTrue(grader.judge_verdict('Yes.')); self.assertFalse(grader.judge_verdict('no'))
        for text in ['', 'not yes', 'yes or no', 'HTTP 500 yes', 'no, although it says yes', '{"correct":true}']:
            with self.subTest(text=text):
                with self.assertRaises(ValueError): grader.judge_verdict(text)

if __name__ == '__main__': unittest.main()

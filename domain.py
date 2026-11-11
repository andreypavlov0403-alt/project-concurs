"""Event schema and score validation, independent from HTTP and SQLite."""
from datetime import datetime
import math


def text(value, title, maximum, required=False):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()):
        raise ValueError(f'{title}: проверьте значение (до {maximum} символов)')
    return value.strip()


def validate_event(data):
    if not isinstance(data, dict):
        raise ValueError('Ожидается объект мероприятия')
    name = text(data.get('eventName'), 'Название', 150, True)
    maximum = data.get('maxScore')
    if type(maximum) is not int or not 1 <= maximum <= 10000:
        raise ValueError('Максимальный балл: целое число от 1 до 10000')
    settings = data.get('settings', {})
    if not isinstance(settings, dict):
        raise ValueError('Проверьте настройки мероприятия')
    config = {key:text(settings.get(key, ''), label, limit) for key,label,limit in [
        ('subject','Предмет',100), ('description','Описание',2000), ('school','Школа',150)]}
    for key in ['startsAt','endsAt']:
        value = settings.get(key, '')
        if not isinstance(value, str):
            raise ValueError('Проверьте время мероприятия')
        if value:
            try:
                parsed = datetime.fromisoformat(value.replace('Z','+00:00'))
                if parsed.tzinfo is None:
                    raise ValueError()
            except ValueError:
                raise ValueError('Время должно содержать часовой пояс') from None
        config[key] = value
    if config['startsAt'] and config['endsAt'] and datetime.fromisoformat(config['endsAt'].replace('Z','+00:00')) <= datetime.fromisoformat(config['startsAt'].replace('Z','+00:00')):
        raise ValueError('Окончание должно быть позже начала')
    config['status'] = settings.get('status','draft')
    config['visibility'] = settings.get('visibility','names')
    if config['status'] not in {'draft','live','finished'} or config['visibility'] not in {'names','codes'}:
        raise ValueError('Проверьте статус и видимость рейтинга')
    for key, default in [('approvalRequired',True), ('showLeaderboard',True)]:
        value = settings.get(key,default)
        if type(value) is not bool:
            raise ValueError('Проверьте настройки доступа')
        config[key] = value
    tasks = data.get('tasks', [])
    if not isinstance(tasks,list) or len(tasks) > 20:
        raise ValueError('Допускается до 20 задач')
    task_ids=set();clean_tasks=[]
    for task in tasks:
        if not isinstance(task,dict):
            raise ValueError('Проверьте задачу')
        ident=text(task.get('id'),'Код задачи',40,True)
        title=text(task.get('title'),'Название задачи',80,True)
        limit=task.get('maxScore')
        if ident in task_ids or type(limit) is not int or not 1 <= limit <= 10000:
            raise ValueError('Коды задач должны быть уникальны; максимум — целое положительное число')
        task_ids.add(ident);clean_tasks.append(dict(id=ident,title=title,maxScore=limit))
    if tasks and sum(t['maxScore'] for t in clean_tasks) != maximum:
        raise ValueError('Максимальный балл должен равняться сумме максимумов задач')
    people=data.get('participants')
    if not isinstance(people,list) or len(people)>10000:
        raise ValueError('Допускается до 10000 участников')
    ids=set();cleaned=[]
    def valid_score(score,limit):
        return score is None or (type(score) in (int,float) and math.isfinite(score) and 0 <= score <= limit)
    for p in people:
        if not isinstance(p,dict):
            raise ValueError('Некорректная запись участника')
        ident=text(p.get('id'),'Идентификатор',100,True)
        if ident in ids:
            raise ValueError('Идентификаторы должны быть уникальными')
        label=text(p.get('name'),'Имя',100,True);group=text(p.get('className'),'Класс',30,True)
        score=p.get('score')
        if not valid_score(score,maximum):
            raise ValueError('Баллы выходят за пределы мероприятия')
        person=dict(id=ident,name=label,className=group,score=score)
        if 'taskScores' in p:
            scores=p['taskScores']
            if not isinstance(scores,dict) or set(scores)-task_ids:
                raise ValueError('Баллы содержат неизвестные задачи')
            values={t['id']:scores.get(t['id']) for t in clean_tasks}
            if any(not valid_score(values[t['id']],t['maxScore']) for t in clean_tasks):
                raise ValueError('Баллы задачи превышают её максимум')
            person['taskScores']=values
            person['score']=sum(v for v in values.values() if v is not None) if any(v is not None for v in values.values()) else None
        ids.add(ident);cleaned.append(person)
    return dict(eventName=name,maxScore=maximum,participants=cleaned,settings=config,tasks=clean_tasks)
